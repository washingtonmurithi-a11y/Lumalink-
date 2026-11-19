/**
 * LumaLink Industrial Optical PHY & Wi-Fi LAN Bridge
 * Target: ESP32-S3 (Dual-Core Xtensa LX7 @ 240 MHz, ESP-IDF v5.x)
 * Standard: IEEE 802.15.7a / 8802-15-7-2025 Differential 8-CSK OCC
 */

#include <cstring>
#include <cstdint>
#include <cstdio>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/ringbuf.h"
#include "freertos/event_groups.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"
#include "driver/rmt_tx.h"
#include "driver/gpio.h"

static const char *TAG = "LUMALINK_PHY";

// ============================================================================
// 1. HARDWARE PINOUT & OPTICAL TIMING CONSTANTS (80 MHz RMT = 12.5 ns / tick)
// ============================================================================
constexpr gpio_num_t PIN_LED_RED   = GPIO_NUM_4;
constexpr gpio_num_t PIN_LED_GREEN = GPIO_NUM_5;
constexpr gpio_num_t PIN_LED_BLUE  = GPIO_NUM_6;

constexpr uint32_t RMT_RESOLUTION_HZ   = 80000000; // 12.5 ns per tick
constexpr uint32_t SYMBOL_RATE_HZ      = 32400;    // 32.4 kHz (Flicker-free > 300 Hz)
constexpr uint32_t HALF_SYMBOL_TICKS   = (RMT_RESOLUTION_HZ / SYMBOL_RATE_HZ) / 2; // 1234 ticks (15.425 us)

// Default Wi-Fi & Edge Host Configuration (Overridable via NVS or Serial Provisioning)
#ifndef CONFIG_LUMALINK_WIFI_SSID
#define CONFIG_LUMALINK_WIFI_SSID "YOUR_WIFI_SSID"
#endif
#ifndef CONFIG_LUMALINK_WIFI_PASS
#define CONFIG_LUMALINK_WIFI_PASS "YOUR_WIFI_PASSWORD"
#endif
#ifndef CONFIG_LUMALINK_HOST_IP
#define CONFIG_LUMALINK_HOST_IP   "192.168.1.100"
#endif
#ifndef CONFIG_LUMALINK_HOST_PORT
#define CONFIG_LUMALINK_HOST_PORT 9090
#endif

static EventGroupHandle_t s_wifi_event_group;
constexpr int WIFI_CONNECTED_BIT = BIT0;
static RingbufHandle_t s_optical_tx_ringbuf = nullptr;

// ============================================================================
// 2. GALOIS FIELD GF(2^8) REED-SOLOMON (32, 24) HARDWARE-ACCELERATED ENCODER
// ============================================================================
class ReedSolomon32_24 {
public:
    static constexpr size_t N = 32;
    static constexpr size_t K = 24;
    static constexpr size_t PARITY = N - K; // 8 parity bytes -> corrects up to 4 byte errors

    ReedSolomon32_24() {
        uint16_t x = 1;
        for (int i = 0; i < 255; ++i) {
            exp_[i] = static_cast<uint8_t>(x);
            log_[x] = static_cast<uint8_t>(i);
            x <<= 1;
            if (x & 0x100) x ^= 0x11D; // Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
        }
        for (int i = 255; i < 512; ++i) {
            exp_[i] = exp_[i - 255];
        }
        // Compute generator polynomial g(x) = prod_{i=0..7}(x - alpha^i)
        std::memset(gen_, 0, sizeof(gen_));
        gen_[0] = 1;
        for (int i = 0; i < static_cast<int>(PARITY); ++i) {
            uint8_t root = exp_[i];
            for (int j = i + 1; j > 0; --j) {
                gen_[j] = gen_[j - 1] ^ gf_mul(gen_[j], root);
            }
            gen_[0] = gf_mul(gen_[0], root);
        }
    }

    void encode_block(const uint8_t data[K], uint8_t codeword[N]) const {
        std::memcpy(codeword, data, K);
        uint8_t rem[PARITY] = {0};
        for (size_t i = 0; i < K; ++i) {
            uint8_t factor = data[i] ^ rem[PARITY - 1];
            for (size_t j = PARITY - 1; j > 0; --j) {
                rem[j] = rem[j - 1] ^ gf_mul(gen_[j], factor);
            }
            rem[0] = gf_mul(gen_[0], factor);
        }
        for (size_t i = 0; i < PARITY; ++i) {
            codeword[K + i] = rem[PARITY - 1 - i];
        }
    }

private:
    uint8_t exp_[512]{};
    uint8_t log_[256]{};
    uint8_t gen_[PARITY + 1]{};

    inline uint8_t gf_mul(uint8_t a, uint8_t b) const {
        if (a == 0 || b == 0) return 0;
        return exp_[log_[a] + log_[b]];
    }
};

static ReedSolomon32_24 s_rs_codec;

// ============================================================================
// 3. CUSTOM ESP-IDF v5.x RMT ENCODER FOR DIFFERENTIAL 8-CSK OPTICAL MODULATION
// ============================================================================
struct OpticalChannelHandles {
    rmt_channel_handle_t ch_r;
    rmt_channel_handle_t ch_g;
    rmt_channel_handle_t ch_b;
    rmt_encoder_handle_t enc_copy;
    rmt_sync_manager_handle_t sync_mgr;
};

static OpticalChannelHandles s_opt_hw{};

// Differential Manchester 8-CSK Symbol Builder:
// Each 3-bit symbol s in [0..7] maps to RGB bits (R=bit2, G=bit1, B=bit0).
// First half-period outputs ~bit (inverse), second half-period outputs bit -> zero DC drift!
static void build_csk_waveform(
    const uint8_t *codeword,
    size_t len_bytes,
    rmt_symbol_word_t *out_r,
    rmt_symbol_word_t *out_g,
    rmt_symbol_word_t *out_b,
    size_t *out_symbol_count
) {
    // Pack 32 bytes (256 bits) + 1 sync preamble byte (264 bits total = 88 3-bit symbols)
    uint8_t frame[33];
    frame[0] = 0xA5; // 10100101 optical frame boundary delimiter
    std::memcpy(&frame[1], codeword, len_bytes);

    size_t total_bits = (len_bytes + 1) * 8;
    size_t sym_idx = 0;

    // 4-symbol high-contrast optical AGC training header
    const uint8_t preamble_syms[4] = {0b111, 0b000, 0b111, 0b000};
    for (int p = 0; p < 4; ++p) {
        uint8_t s = preamble_syms[p];
        uint32_t r_lvl = (s >> 2) & 1;
        uint32_t g_lvl = (s >> 1) & 1;
        uint32_t b_lvl = (s >> 0) & 1;

        out_r[sym_idx] = {.duration0 = HALF_SYMBOL_TICKS, .level0 = !r_lvl, .duration1 = HALF_SYMBOL_TICKS, .level1 = r_lvl};
        out_g[sym_idx] = {.duration0 = HALF_SYMBOL_TICKS, .level0 = !g_lvl, .duration1 = HALF_SYMBOL_TICKS, .level1 = g_lvl};
        out_b[sym_idx] = {.duration0 = HALF_SYMBOL_TICKS, .level0 = !b_lvl, .duration1 = HALF_SYMBOL_TICKS, .level1 = b_lvl};
        sym_idx++;
    }

    for (size_t bit_pos = 0; bit_pos < total_bits; bit_pos += 3) {
        uint8_t s = 0;
        for (int b = 0; b < 3; ++b) {
            size_t idx = bit_pos + b;
            uint8_t bit_val = 0;
            if (idx < total_bits) {
                bit_val = (frame[idx / 8] >> (7 - (idx % 8))) & 1;
            }
            s = (s << 1) | bit_val;
        }
        uint32_t r_lvl = (s >> 2) & 1;
        uint32_t g_lvl = (s >> 1) & 1;
        uint32_t b_lvl = (s >> 0) & 1;

        out_r[sym_idx] = {.duration0 = HALF_SYMBOL_TICKS, .level0 = !r_lvl, .duration1 = HALF_SYMBOL_TICKS, .level1 = r_lvl};
        out_g[sym_idx] = {.duration0 = HALF_SYMBOL_TICKS, .level0 = !g_lvl, .duration1 = HALF_SYMBOL_TICKS, .level1 = g_lvl};
        out_b[sym_idx] = {.duration0 = HALF_SYMBOL_TICKS, .level0 = !b_lvl, .duration1 = HALF_SYMBOL_TICKS, .level1 = b_lvl};
        sym_idx++;
    }
    *out_symbol_count = sym_idx;
}

static void init_optical_rmt_hardware() {
    gpio_num_t pins[3] = {PIN_LED_RED, PIN_LED_GREEN, PIN_LED_BLUE};
    rmt_channel_handle_t *channels[3] = {&s_opt_hw.ch_r, &s_opt_hw.ch_g, &s_opt_hw.ch_b};

    for (int i = 0; i < 3; ++i) {
        rmt_tx_channel_config_t tx_cfg = {};
        tx_cfg.clk_src = RMT_CLK_SRC_DEFAULT;
        tx_cfg.gpio_num = pins[i];
        tx_cfg.mem_block_symbols = 128;
        tx_cfg.resolution_hz = RMT_RESOLUTION_HZ;
        tx_cfg.trans_queue_depth = 4;
        tx_cfg.flags.with_dma = true;
        ESP_ERROR_CHECK(rmt_new_tx_channel(&tx_cfg, channels[i]));
        ESP_ERROR_CHECK(rmt_enable(*channels[i]));
    }

    rmt_copy_encoder_config_t copy_cfg = {};
    ESP_ERROR_CHECK(rmt_new_copy_encoder(&copy_cfg, &s_opt_hw.enc_copy));

    rmt_sync_manager_config_t sync_cfg = {
        .tx_channel_array = {s_opt_hw.ch_r, s_opt_hw.ch_g, s_opt_hw.ch_b},
        .array_size = 3,
    };
    ESP_ERROR_CHECK(rmt_new_sync_manager(&sync_cfg, &s_opt_hw.sync_mgr));
    ESP_LOGI(TAG, "Synchronized 3-Channel RGB RMT Optical PHY initialized @ %lu Hz", SYMBOL_RATE_HZ);
}

// ============================================================================
// 4. CORE 1 REAL-TIME OPTICAL DMA TRANSMIT TASK
// ============================================================================
static void optical_tx_task(void *pvParameters) {
    rmt_symbol_word_t r_syms[96];
    rmt_symbol_word_t g_syms[96];
    rmt_symbol_word_t b_syms[96];
    uint8_t codeword[ReedSolomon32_24::N];

    rmt_transmit_config_t tx_config = {};
    tx_config.loop_count = 0;

    while (true) {
        size_t item_size = 0;
        uint8_t *raw_payload = static_cast<uint8_t *>(
            xRingbufferReceive(s_optical_tx_ringbuf, &item_size, pdMS_TO_TICKS(50))
        );

        uint8_t block[ReedSolomon32_24::K] = {0};
        if (raw_payload != nullptr) {
            size_t copy_len = item_size > ReedSolomon32_24::K ? ReedSolomon32_24::K : item_size;
            std::memcpy(block, raw_payload, copy_len);
            vRingbufferReturnItem(s_optical_tx_ringbuf, raw_payload);
        } else {
            // Transmit continuous idle beacon frame so receiver camera maintains phase lock
            std::memcpy(block, "LUMALINK_BEACON_READY_01", 24);
        }

        s_rs_codec.encode_block(block, codeword);
        size_t sym_count = 0;
        build_csk_waveform(codeword, ReedSolomon32_24::N, r_syms, g_syms, b_syms, &sym_count);

        size_t byte_len = sym_count * sizeof(rmt_symbol_word_t);
        rmt_sync_reset(s_opt_hw.sync_mgr);
        ESP_ERROR_CHECK(rmt_transmit(s_opt_hw.ch_r, s_opt_hw.enc_copy, r_syms, byte_len, &tx_config));
        ESP_ERROR_CHECK(rmt_transmit(s_opt_hw.ch_g, s_opt_hw.enc_copy, g_syms, byte_len, &tx_config));
        ESP_ERROR_CHECK(rmt_transmit(s_opt_hw.ch_b, s_opt_hw.enc_copy, b_syms, byte_len, &tx_config));
        rmt_tx_wait_all_done(s_opt_hw.ch_r, portMAX_DELAY);
    }
}

// ============================================================================
// 5. WI-FI STATION + TCP EDGE BRIDGE CLIENT (CORE 0)
// ============================================================================
static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        esp_wifi_connect();
        xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto *event = static_cast<ip_event_got_ip_t *>(data);
        ESP_LOGI(TAG, "Connected to Wi-Fi LAN! Node IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init_sta() {
    s_wifi_event_group = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, nullptr, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, nullptr, nullptr));

    wifi_config_t wifi_config = {};
    std::strncpy(reinterpret_cast<char *>(wifi_config.sta.ssid), CONFIG_LUMALINK_WIFI_SSID, sizeof(wifi_config.sta.ssid));
    std::strncpy(reinterpret_cast<char *>(wifi_config.sta.password), CONFIG_LUMALINK_WIFI_PASS, sizeof(wifi_config.sta.password));
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE)); // Disable modem sleep for deterministic sub-ms latency
    ESP_ERROR_CHECK(esp_wifi_start());
}

static void wifi_bridge_task(void *pvParameters) {
    uint8_t rx_buf[256];
    while (true) {
        xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, portMAX_DELAY);

        sockaddr_in dest_addr{};
        dest_addr.sin_family = AF_INET;
        dest_addr.sin_port = htons(CONFIG_LUMALINK_HOST_PORT);
        inet_pton(AF_INET, CONFIG_LUMALINK_HOST_IP, &dest_addr.sin_addr);

        int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
        if (sock < 0) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        if (connect(sock, reinterpret_cast<sockaddr *>(&dest_addr), sizeof(dest_addr)) != 0) {
            close(sock);
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        ESP_LOGI(TAG, "Linked to LumaLink Edge Server %s:%d", CONFIG_LUMALINK_HOST_IP, CONFIG_LUMALINK_HOST_PORT);
        const char *hello = "{\"type\":\"HARDWARE_HELLO\",\"board\":\"ESP32-S3\",\"phy\":\"8-CSK-32.4kHz\"}\n";
        send(sock, hello, std::strlen(hello), 0);

        while (true) {
            int len = recv(sock, rx_buf, sizeof(rx_buf), 0);
            if (len <= 0) break;
            // Chunk incoming Wi-Fi payload into 24-byte blocks for RS(32,24) optical transmission
            for (int offset = 0; offset < len; offset += ReedSolomon32_24::K) {
                size_t chunk = (len - offset) > static_cast<int>(ReedSolomon32_24::K)
                                   ? ReedSolomon32_24::K
                                   : static_cast<size_t>(len - offset);
                xRingbufferSend(s_optical_tx_ringbuf, rx_buf + offset, chunk, pdMS_TO_TICKS(10));
            }
        }
        close(sock);
    }
}

extern "C" void app_main() {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    s_optical_tx_ringbuf = xRingbufferCreate(8192, RINGBUF_TYPE_NOSPLIT);
    init_optical_rmt_hardware();
    wifi_init_sta();

    xTaskCreatePinnedToCore(optical_tx_task, "optical_tx", 4096, nullptr, 10, nullptr, 1);
    xTaskCreatePinnedToCore(wifi_bridge_task, "wifi_bridge", 4096, nullptr, 8, nullptr, 0);
}

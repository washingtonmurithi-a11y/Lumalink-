files["firmware/esp32s3_lumalink_phy/main/lumalink_phy.cpp"] = """/
@file firmware/esp32s3_lumalink_phy/main/lumalink_phy.cpp
@description Bare-Metal ESP-IDF v5.x C++20 Dual-Core Optical 8-CSK & Wi-Fi TCP Bridge
Uses 80 MHz RMT hardware timers (12.5 ns resolution) with rmt_enable() called prior
to rmt_new_sync_manager() per Espressif ESP-IDF v5.x hardware synchronization rules.
*/
#include 
#include 
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/ringbuf.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "lwip/sockets.h"
#include "driver/rmt_tx.h"
#include "driver/gpio.h"
static const char *TAG = "LUMALINK_ESP32S3";
constexpr gpio_num_t PIN_R = GPIO_NUM_4;
constexpr gpio_num_t PIN_G = GPIO_NUM_5;
constexpr gpio_num_t PIN_B = GPIO_NUM_6;
constexpr uint32_t RMT_CLK_HZ        = 80000000;
constexpr uint32_t SYMBOL_RATE_HZ    = 32400;
constexpr uint32_t HALF_PERIOD_TICKS = (RMT_CLK_HZ / SYMBOL_RATE_HZ) / 2;
#ifndef LUMALINK_WIFI_SSID
#define LUMALINK_WIFI_SSID "YOUR_WIFI_SSID"
#endif
#ifndef LUMALINK_WIFI_PASS
#define LUMALINK_WIFI_PASS "YOUR_WIFI_PASSWORD"
#endif
#ifndef LUMALINK_HOST_IP
#define LUMALINK_HOST_IP   "192.168.1.100"
#endif
#ifndef LUMALINK_HOST_PORT
#define LUMALINK_HOST_PORT 9090
#endif
static EventGroupHandle_t s_wifi_events;
static RingbufHandle_t s_tx_ringbuf = nullptr;
class ReedSolomon32_24 {
public:
static constexpr size_t N = 32;
static constexpr size_t K = 24;
static constexpr size_t PARITY = 8;
ReedSolomon32_24() {
    uint16_t x = 1;
    for (int i = 0; i < 255; ++i) {
        exp_[i] = static_cast<uint8_t>(x);
        log_[x] = static_cast<uint8_t>(i);
        x <<= 1;
        if (x & 0x100) x ^= 0x11D;
    }
    for (int i = 255; i < 512; ++i) exp_[i] = exp_[i - 255];

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

void encode(const uint8_t data[K], uint8_t out[N]) const {
    std::memcpy(out, data, K);
    uint8_t rem[PARITY] = {0};
    for (size_t i = 0; i < K; ++i) {
        uint8_t factor = data[i] ^ rem[PARITY - 1];
        for (size_t j = PARITY - 1; j > 0; --j) {
            rem[j] = rem[j - 1] ^ gf_mul(gen_[j], factor);
        }
        rem[0] = gf_mul(gen_[0], factor);
    }
    for (size_t i = 0; i < PARITY; ++i) out[K + i] = rem[PARITY - 1 - i];
}
private:
uint8_t exp_[512]{};
uint8_t log_[256]{};
uint8_t gen_[PARITY + 1]{};
inline uint8_t gf_mul(uint8_t a, uint8_t b) const {
    return (a == 0 || b == 0) ? 0 : exp_[log_[a] + log_[b]];
}
};
static ReedSolomon32_24 s_rs;
static rmt_channel_handle_t s_ch[3];
static rmt_encoder_handle_t s_enc;
static rmt_sync_manager_handle_t s_sync;
static void init_rmt_optical_phy() {
gpio_num_t pins[3] = {PIN_R, PIN_G, PIN_B};
for (int i = 0; i < 3; ++i) {
rmt_tx_channel_config_t cfg = {};
cfg.clk_src = RMT_CLK_SRC_DEFAULT;
cfg.gpio_num = pins[i];
cfg.mem_block_symbols = 128;
cfg.resolution_hz = RMT_CLK_HZ;
cfg.trans_queue_depth = 4;
cfg.flags.with_dma = true;
ESP_ERROR_CHECK(rmt_new_tx_channel(&cfg, &s_ch[i]));
ESP_ERROR_CHECK(rmt_enable(s_ch[i]));
}
rmt_copy_encoder_config_t copy_cfg = {};
ESP_ERROR_CHECK(rmt_new_copy_encoder(&copy_cfg, &s_enc));

rmt_sync_manager_config_t sync_cfg = {
    .tx_channel_array = {s_ch[0], s_ch[1], s_ch[2]},
    .array_size = 3
};
ESP_ERROR_CHECK(rmt_new_sync_manager(&sync_cfg, &s_sync));
}
static void optical_tx_task(void *) {
rmt_symbol_word_t syms[3][96];
uint8_t cw[32];
rmt_transmit_config_t tx_cfg = {};
while (true) {
    size_t len = 0;
    auto *item = static_cast<uint8_t *>(xRingbufferReceive(s_tx_ringbuf, &len, pdMS_TO_TICKS(50)));
    uint8_t block[24] = {0};
    if (item) {
        std::memcpy(block, item, len > 24 ? 24 : len);
        vRingbufferReturnItem(s_tx_ringbuf, item);
    } else {
        std::memcpy(block, "LUMALINK_OPTICAL_BEACON_", 24);
    }

    s_rs.encode(block, cw);
    size_t idx = 0;
    for (size_t b = 0; b < 32; ++b) {
        uint8_t s = cw[b] & 0x07;
        for (int c = 0; c < 3; ++c) {
            uint32_t lvl = (s >> (2 - c)) & 1;
            syms[c][idx] = {
                .duration0 = HALF_PERIOD_TICKS,
                .level0 = !lvl,
                .duration1 = HALF_PERIOD_TICKS,
                .level1 = lvl
            };
        }
        idx++;
    }

    rmt_sync_reset(s_sync);
    for (int c = 0; c < 3; ++c) {
        ESP_ERROR_CHECK(rmt_transmit(s_ch[c], s_enc, syms[c], idx * sizeof(rmt_symbol_word_t), &tx_cfg));
    }
    rmt_tx_wait_all_done(s_ch[0], portMAX_DELAY);
}
}
static void wifi_handler(void *, esp_event_base_t base, int32_t id, void *) {
if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) esp_wifi_connect();
else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(s_wifi_events, BIT0);
}
static void wifi_bridge_task(void *) {
uint8_t rx[256];
while (true) {
xEventGroupWaitBits(s_wifi_events, BIT0, pdFALSE, pdTRUE, portMAX_DELAY);
sockaddr_in addr{};
addr.sin_family = AF_INET;
addr.sin_port = htons(LUMALINK_HOST_PORT);
inet_pton(AF_INET, LUMALINK_HOST_IP, &addr.sin_addr);
    int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    if (sock < 0) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
    if (connect(sock, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
        close(sock);
        vTaskDelay(pdMS_TO_TICKS(2000));
        continue;
    }
    ESP_LOGI(TAG, "Connected to LumaLink Edge Gateway %s:%d", LUMALINK_HOST_IP, LUMALINK_HOST_PORT);
    while (true) {
        int n = recv(sock, rx, sizeof(rx), 0);
        if (n <= 0) break;
        for (int off = 0; off < n; off += 24) {
            size_t chunk = (n - off) > 24 ? 24 : static_cast<size_t>(n - off);
            xRingbufferSend(s_tx_ringbuf, rx + off, chunk, pdMS_TO_TICKS(10));
        }
    }
    close(sock);
}
}
extern "C" void app_main() {
ESP_ERROR_CHECK(nvs_flash_init());
s_tx_ringbuf = xRingbufferCreate(8192, RINGBUF_TYPE_NOSPLIT);
init_rmt_optical_phy();
s_wifi_events = xEventGroupCreate();
ESP_ERROR_CHECK(esp_netif_init());
ESP_ERROR_CHECK(esp_event_loop_create_default());
esp_netif_create_default_wifi_sta();
wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
ESP_ERROR_CHECK(esp_wifi_init(&wcfg));
ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_handler, nullptr, nullptr));
ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_handler, nullptr, nullptr));

wifi_config_t sta = {};
std::strncpy(reinterpret_cast<char *>(sta.sta.ssid), LUMALINK_WIFI_SSID, sizeof(sta.sta.ssid));
std::strncpy(reinterpret_cast<char *>(sta.sta.password), LUMALINK_WIFI_PASS, sizeof(sta.sta.password));
ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
ESP_ERROR_CHECK(esp_wifi_start());

xTaskCreatePinnedToCore(optical_tx_task, "optical_tx", 4096, nullptr, 10, nullptr, 1);
xTaskCreatePinnedToCore(wifi_bridge_task, "wifi_bridge", 4096, nullptr, 8, nullptr, 0);
}
"""

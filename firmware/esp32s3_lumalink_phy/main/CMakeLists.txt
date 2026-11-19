files["firmware/esp32s3_lumalink_phy/main/CMakeLists.txt"] = """idf_component_register(
SRCS "lumalink_phy.cpp"
INCLUDE_DIRS "."
REQUIRES driver esp_wifi esp_event esp_netif nvs_flash lwip
)
"""

(function () {
  const endpoint = "https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine";

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) && number !== 0 ? number : null;
  }

  function resultUrl(item) {
    const id = item.id ? encodeURIComponent(String(item.id)) : "";
    const cityId = item.cityId ? encodeURIComponent(String(item.cityId)) : "";
    const cityName = item.cityName ? encodeURIComponent(String(item.cityName)) : "";
    if (item.type === "City" && cityId) return "https://hotels.ctrip.com/hotels/list?city=" + cityId;
    if (item.type === "Hotel" && id) return "https://hotels.ctrip.com/hotels/detail/?hotelid=" + id;
    if ((item.type === "BusinessArea" || item.type === "Zone") && cityId && id) return "https://hotels.ctrip.com/hotels/list?city=" + cityId + "&zone=" + id;
    if (item.type === "RailwayStation" && id) return "https://trains.ctrip.com/trainstation/" + id + ".html";
    return null;
  }

  window.__ctrip_com_suggest = async function (params, searchType) {
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    if (!query) fail("INVALID_ARGS", "query must be a non-empty string");
    const limit = window.__ctrip_com_common.integer("limit", params?.limit, 15, 1, 50);
    let response;
    try {
      response = await window.__webmcpWecliRuntime.requestPrivileged("backend_fetch", {
        url: endpoint,
        browserFallback: false,
        redactBodyInTrace: true,
        options: {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            keyword: query,
            searchType,
            platform: "online",
            pageID: "102001",
            head: {
              Locale: "zh-CN",
              LocaleController: "zh_cn",
              Currency: "CNY",
              PageId: "102001",
              clientID: "weworker-ctrip",
              group: "ctrip",
              Frontend: { sessionID: 1, pvid: 1 },
              HotelExtension: { group: "CTRIP", WebpSupport: false }
            }
          })
        }
      });
    } catch {
      fail("FETCH_ERROR", "Ctrip suggest request failed; check connectivity and retry");
    }
    if (response?.redirected || response?.url !== endpoint || (response?.status >= 300 && response?.status < 400)) {
      fail("HTTP_ERROR", "Ctrip suggest redirected unexpectedly");
    }
    if (!response.ok) fail("HTTP_ERROR", "Ctrip suggest returned HTTP " + response.status);
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      fail("COMMAND_EXEC", "Ctrip suggest returned invalid JSON");
    }
    if (payload?.Result === false) fail("COMMAND_EXEC", "Ctrip suggest rejected the query (code " + String(payload.ErrorCode ?? "unknown") + ")");
    const suggestions = payload?.Response?.searchResults;
    if (!Array.isArray(suggestions)) fail("COMMAND_EXEC", "Ctrip suggest response has no searchResults array");
    const rows = suggestions.filter((item) => item && typeof item === "object").slice(0, limit).map((item, index) => {
      const name = String(item.displayName || item.word || item.cityName || "").replace(/\s+/g, " ").trim();
      const coordinates = [[item.gdLat, item.gdLon], [item.gLat, item.gLon], [item.lat, item.lon]]
        .find(([latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0));
      return {
        rank: index + 1,
        id: item.id ? String(item.id) : null,
        resultId: item.type && (item.id || item.cityId) ? `${item.type}:${item.id || item.cityId}` : null,
        hotelId: item.type === 'Hotel' && item.id ? String(item.id) : null,
        hotelCityId: item.type === 'City' ? numberOrNull(item.cityId) : null,
        type: item.type ? String(item.type) : null,
        displayType: item.displayType ? String(item.displayType).trim() : null,
        name,
        eName: item.eName ? String(item.eName).trim() : null,
        cityId: numberOrNull(item.cityId),
        cityName: item.cityName ? String(item.cityName).trim() : null,
        provinceName: item.provinceName ? String(item.provinceName).trim() : null,
        countryName: item.countryName ? String(item.countryName).trim() : null,
        lat: coordinates ? coordinates[0] : null,
        lon: coordinates ? coordinates[1] : null,
        score: numberOrNull(item.commentScore) ?? numberOrNull(item.cStar),
        url: resultUrl(item)
      };
    }).filter((row) => row.name);
    if (!rows.length) fail("EMPTY_RESULT", "No matching Ctrip suggestions");
    return rows;
  };
})();

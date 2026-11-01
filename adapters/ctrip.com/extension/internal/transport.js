(function () {
  const common = new Proxy({}, { get: (_target, key) => window.__ctrip_com_common[key] });
  const runtime = window.__webmcpWecliRuntime;

  function route(params) {
    const from = common.place("from", params.from);
    const to = common.place("to", params.to);
    if (from === to) common.fail("INVALID_ARGS", "from and to must differ");
    return { from, to, date: common.date("date", params.date), limit: common.integer("limit", params.limit, 20, 1, 50) };
  }

  async function waitForRows(selector, timeoutMs, emptyPattern) {
    return common.waitFor(() => {
      if (common.hasCaptcha()) return "captcha";
      if (document.querySelector(selector)) return "content";
      if (emptyPattern?.test(document.body?.innerText || "")) return "empty";
      return null;
    }, timeoutMs);
  }

  function assertReady(state, label) {
    if (state === "captcha") common.fail("AUTH_REQUIRED", "Ctrip is asking for verification; complete it in the browser and retry");
    if (state !== "content") common.fail(state === "empty" ? "EMPTY_RESULT" : "COMMAND_EXEC", `Ctrip ${label} page did not render results (${state})`);
  }

  async function train(params) {
    const values = route(params);
    const query = new URLSearchParams({ dStationName: values.from, aStationName: values.to, dDate: values.date, ticketType: "1" });
    const target = `https://trains.ctrip.com/webapp/train/list?${query.toString()}`;
    if (!common.sameUrl(target)) return common.navigate(target);
    const state = await waitForRows(".card-white.list-item", 10000);
    assertReady(state, "train");
    const rendered = await common.scrollUntil(".card-white.list-item", values.limit, 8);
    const rows = Array.from(document.querySelectorAll(".card-white.list-item")).map((card) => {
      const trainNo = common.text(card.querySelector(".checi"));
      const departureTime = common.text(card.querySelector(".from .time"));
      const departureStation = common.text(card.querySelector(".from .station"));
      const arrivalTime = common.text(card.querySelector(".to .time"));
      const arrivalStation = common.text(card.querySelector(".to .station"));
      if (!trainNo || !departureTime || !departureStation || !arrivalTime || !arrivalStation) return null;
      const priceText = common.text(card.querySelector(".rbox .price"));
      return {
        trainNo,
        departureTime,
        departureStation,
        arrivalTime,
        arrivalStation,
        duration: common.text(card.querySelector(".haoshi")) || null,
        fromPrice: /^\d+(?:\.\d+)?$/.test(priceText) ? Number(priceText) : null,
        seats: Array.from(card.querySelectorAll(".surplus-list > li")).map((item) => common.text(item).replace(/\s+/g, "")).filter(Boolean).join(" / ") || null
      };
    }).filter(Boolean);
    if (!rows.length) common.fail(rendered > 0 ? "COMMAND_EXEC" : "EMPTY_RESULT", rendered > 0 ? "Ctrip train cards were missing required fields" : "No matching trains");
    return rows.slice(0, values.limit).map((row, index) => ({ rank: index + 1, ...row, url: target }));
  }

  async function bus(params) {
    const values = route(params);
    const payload = JSON.stringify({ fromCity: values.from, toCity: values.to, fromDate: values.date, fromStation: "", toStation: "" });
    const target = `https://bus.ctrip.com/list?param=${encodeURIComponent(payload)}`;
    if (!common.sameUrl(target)) return common.navigate(target);
    const state = await waitForRows(".list-item-parent", 12000);
    assertReady(state, "bus");
    const rendered = await common.scrollUntil(".list-item-parent", values.limit, 8);
    const rows = Array.from(document.querySelectorAll(".list-item-parent")).map((card) => {
      const departureTime = (common.text(card.querySelector(".list-width150")).match(/\d{1,2}:\d{2}/) || [""])[0];
      const stations = Array.from(card.querySelectorAll(".list-width200 .cor333")).map(common.text).filter(Boolean);
      if (!departureTime || !stations[0] || !stations[1]) return null;
      const priceText = common.text(card.querySelector(".corred"));
      return {
        departureTime,
        fromStation: stations[0],
        toStation: stations[1],
        duration: common.text(card.querySelector(".bus-desc")) || null,
        price: /^\d+(?:\.\d+)?$/.test(priceText) ? Number(priceText) : null,
        status: common.text(card.querySelector(".list-seat-parent")) || null
      };
    }).filter(Boolean);
    if (!rows.length) common.fail(rendered > 0 ? "COMMAND_EXEC" : "EMPTY_RESULT", rendered > 0 ? "Ctrip bus cards were missing required fields" : "No matching coaches");
    return rows.slice(0, values.limit).map((row, index) => ({ rank: index + 1, ...row, url: target }));
  }

  async function ferry(params) {
    const values = route(params);
    const payload = JSON.stringify({ fromCityName: values.from, toCityName: values.to, date: values.date });
    const target = `https://ship.ctrip.com/ship/list?param=${encodeURIComponent(payload)}`;
    if (!common.sameUrl(target)) return common.navigate(target);
    const state = await common.waitFor(() => {
      if (common.hasCaptcha()) return "captcha";
      if (document.querySelector(".list-item-parent")) return "content";
      if (document.querySelector(".list-no-data-parent")) return "no-information";
      return null;
    }, 12000);
    // The site uses the same empty view for empty responses and request failures.
    // Do not infer that the route has no sailings, or report a rendering timeout.
    if (state === "no-information") common.fail("COMMAND_EXEC", "Ctrip ferry page reports no sailing information for the requested route/date. This page state can also result from an upstream request failure; it does not prove that no sailings exist. Do not retry unchanged arguments automatically.");
    assertReady(state, "ferry");
    const rendered = await common.scrollUntil(".list-item-parent", values.limit, 8);
    const rows = Array.from(document.querySelectorAll(".list-item-parent")).map((card) => {
      const times = Array.from(card.querySelectorAll(".list-width400 .font600")).map((item) => (common.text(item).match(/\d{1,2}:\d{2}/) || [""])[0]).filter(Boolean);
      const ports = Array.from(card.querySelectorAll(".list-width400 .font12")).map(common.text).filter(Boolean);
      if (!times[0] || !ports[0] || !ports[1]) return null;
      const labels = Array.from(card.querySelectorAll("span.list-width100")).map(common.text).filter(Boolean);
      const duration = labels.find((label) => /(小时|时|分)/.test(label)) || null;
      const priceText = common.text(card.querySelector(".corred"));
      return {
        shipName: labels.find((label) => label !== duration) || null,
        departureTime: times[0],
        fromPort: ports[0],
        arrivalTime: times[1] || null,
        toPort: ports[1],
        duration,
        price: /^\d+(?:\.\d+)?$/.test(priceText) ? Number(priceText) : null,
        status: common.text(card.querySelector(".list-seat-parent")) || null
      };
    }).filter(Boolean);
    if (!rows.length) common.fail(rendered > 0 ? "COMMAND_EXEC" : "EMPTY_RESULT", rendered > 0 ? "Ctrip ferry cards were missing required fields" : "No matching sailings");
    return rows.slice(0, values.limit).map((row, index) => ({ rank: index + 1, ...row, url: target }));
  }

  function flightRoute(params, roundTrip) {
    const from = common.iata("from", params.from);
    const to = common.iata("to", params.to);
    if (from === to) common.fail("INVALID_ARGS", "from and to must differ");
    const limit = common.integer("limit", params.limit, 20, 1, 50);
    if (!roundTrip) return { from, to, limit, date: common.date("date", params.date) };
    const depart = common.date("depart", params.depart);
    const returning = common.date("return", params.return);
    if (returning < depart) common.fail("INVALID_ARGS", "return must be on or after depart");
    return { from, to, limit, depart, returning };
  }

  async function flightRound(params) {
    const values = flightRoute(params, true);
    const target = `https://flights.ctrip.com/online/list/round-${values.from.toLowerCase()}-${values.to.toLowerCase()}?depdate=${values.depart}_${values.returning}&cabin=Y_S_C_F&adult=1&child=0&infant=0`;
    if (!common.sameUrl(target)) {
      await runtime.requestPrivileged("network_capture_start", { pattern: "/international/search/api/search/batchSearch" });
      return common.navigate(target);
    }
    let capture;
    try {
      if (common.hasCaptcha()) assertReady("captcha", "round-trip flight");
      capture = await runtime.requestPrivileged("network_capture_read", { waitMs: 12000, finish: true });
      if (common.hasCaptcha()) assertReady("captcha", "round-trip flight");
    }
    catch (error) {
      if (error.code !== "CAPTURE_NOT_STARTED") throw error;
      await runtime.requestPrivileged("network_capture_start", { pattern: "/international/search/api/search/batchSearch" });
      return common.navigate(target);
    }
    const entries = capture?.entries || [];
    if (!entries.length) {
      await runtime.requestPrivileged("network_capture_start", { pattern: "/international/search/api/search/batchSearch" });
      return common.navigate(target);
    }
    const itineraries = parseFlightCaptures(entries);
    if (!itineraries.length) common.fail("EMPTY_RESULT", "No matching round-trip flights");
    return itineraries.map((item, index) => {
      const segments = item.flightSegments;
      if (!Array.isArray(segments) || segments.length !== 2 || segments[0].segmentNo !== 1 || segments[1].segmentNo !== 2) common.fail("COMMAND_EXEC", "Round-trip response must contain both outbound and return segments");
      const route = (segment, from, to, date) => {
        const legs = segment.flightList || []; const first = legs[0], last = legs[legs.length - 1];
        if (!first || !last || ![first.departureCityCode, first.departureAirportCode].includes(from) || ![last.arrivalCityCode, last.arrivalAirportCode].includes(to) || !String(first.departureDateTime).startsWith(date + ' ')) common.fail("COMMAND_EXEC", "Round-trip response route or date does not match the request");
        const { price, currency, cabin, url, ...leg } = mapItinerary({ ...item, flightSegments: [segment] }, target, index).row;
        return leg;
      };
      const outbound = route(segments[0], values.from, values.to, values.depart);
      const returning = route(segments[1], values.to, values.from, values.returning);
      const price = Number(item.priceList?.[0]?.sortPrice ?? item.priceList?.[0]?.adultPrice);
      if (!Number.isFinite(price) || price < 0) common.fail("COMMAND_EXEC", "Round-trip response price is invalid");
      return { outbound, return: returning, price, currency: "CNY", priceScope: "round_trip_one_adult", cabin: cabinLabel(item.priceList[0].cabin), taxesIncluded: null, url: target };
    }).sort((a, b) => a.price - b.price || a.outbound.departureDateTime.localeCompare(b.outbound.departureDateTime)).slice(0, values.limit).map((row, index) => ({ rank: index + 1, ...row }));
  }

  function timePart(value) {
    return (common.clean(value).match(/(?:^|\s)([0-2]\d:[0-5]\d)(?::[0-5]\d)?$/) || [])[1] || "";
  }

  function cabinLabel(value) {
    const labels = { Y: "经济舱", S: "超级经济舱", C: "公务舱", F: "头等舱" };
    const codes = [...new Set(common.clean(value).toUpperCase().match(/[YSCF]/g) || [])];
    return codes.length ? codes.map((code) => labels[code]).join("/") : common.clean(value) || null;
  }

  function parseFlightCaptures(entries) {
    const captured = (Array.isArray(entries) ? entries : []).filter((entry) => String(entry?.url || "").includes("/international/search/api/search/batchSearch"));
    if (!captured.length) common.fail("TIMEOUT", "No Ctrip batchSearch response was captured");
    const itineraries = new Map();
    let finished = false;
    for (const entry of captured) {
      if (entry.responseStatus === 401 || entry.responseStatus === 403) common.fail("AUTH_REQUIRED", `Ctrip flight API returned HTTP ${entry.responseStatus}`);
      if (entry.responseStatus !== 200) common.fail("COMMAND_EXEC", `Ctrip flight API returned HTTP ${entry.responseStatus || "unknown"}`);
      if (entry.responseBodyTruncated) common.fail("COMMAND_EXEC", `Ctrip flight response exceeded the capture limit (${entry.responseBodyFullSize || "unknown"} bytes)`);
      if (entry.responseBodyError) common.fail("CAPTURE_BODY_UNAVAILABLE", `Ctrip flight response body could not be read from the browser (${entry.responseBodyError})`);
      if (!String(entry.responsePreview || "").trim()) common.fail("CAPTURE_EMPTY_RESPONSE", "Ctrip flight API response body is empty; no flight data was captured");
      let payload;
      try {
        payload = JSON.parse(entry.responsePreview);
      } catch {
        common.fail("COMMAND_EXEC", "Ctrip flight API returned invalid JSON");
      }
      if (payload?.status !== 0 || !Array.isArray(payload?.data?.flightItineraryList) || typeof payload?.data?.context?.finished !== "boolean") {
        common.fail("COMMAND_EXEC", "Ctrip flight API returned a malformed payload");
      }
      for (const itinerary of payload.data.flightItineraryList) {
        if (!itinerary?.itineraryId) common.fail("COMMAND_EXEC", "Ctrip flight itinerary has no ID");
        itineraries.set(String(itinerary.itineraryId), itinerary);
      }
      finished = payload.data.context.finished;
    }
    if (!finished) common.fail("COMMAND_EXEC", "Ctrip flight search did not report completion");
    return [...itineraries.values()];
  }

  function mapItinerary(itinerary, target, index) {
    const segments = itinerary?.flightSegments;
    const prices = itinerary?.priceList;
    if (!Array.isArray(segments) || !segments.length || !Array.isArray(prices) || !prices.length) common.fail("COMMAND_EXEC", `Malformed flight itinerary at index ${index}`);
    const legs = segments.flatMap((segment) => Array.isArray(segment?.flightList) ? segment.flightList : []);
    const first = legs[0];
    const last = legs[legs.length - 1];
    const airline = [...new Set(segments.map((segment) => common.clean(segment?.airlineName)).filter(Boolean))].join(" / ");
    const flightNo = [...new Set(legs.map((leg) => common.clean(leg?.flightNo)).filter(Boolean))].join(" / ");
    const price = Number(prices[0]?.sortPrice ?? prices[0]?.adultPrice);
    const row = {
      airline,
      flightNo,
      aircraft: [...new Set(legs.map((leg) => common.clean(leg?.aircraftName)).filter(Boolean))].join(" / ") || null,
      departureTime: timePart(first?.departureDateTime),
      departureAirport: common.clean(first?.departureAirportName),
      arrivalTime: timePart(last?.arrivalDateTime),
      departureDateTime: common.clean(first?.departureDateTime),
      arrivalDateTime: common.clean(last?.arrivalDateTime),
      connecting: legs.length > 1 || segments.some(segment => Number(segment?.transferCount || 0) > 0),
      stopCount: segments.every(segment => Number.isInteger(segment.stopCount) && segment.stopCount >= 0) ? segments.reduce((total, segment) => total + segment.stopCount, 0) : null,
      stops: legs.flatMap(leg => Array.isArray(leg.stopList) ? leg.stopList.map(stop => ({ city: common.clean(stop.cityName), airport: common.clean(stop.airportName), durationMinutes: Number.isFinite(stop.duration) ? stop.duration : null })) : []),
      segments: legs.map(leg => ({ flightNo: common.clean(leg.flightNo), departureAirport: common.clean(leg.departureAirportName), departureTerminal: common.clean(leg.departureTerminal) || null, arrivalAirport: common.clean(leg.arrivalAirportName), arrivalTerminal: common.clean(leg.arrivalTerminal) || null, departureDateTime: common.clean(leg.departureDateTime), arrivalDateTime: common.clean(leg.arrivalDateTime) })),
      arrivalAirport: common.clean(last?.arrivalAirportName),
      departureTerminal: common.clean(first?.departureTerminal) || null,
      arrivalTerminal: common.clean(last?.arrivalTerminal) || null,
      terminal: common.clean(last?.arrivalTerminal) || null,
      price,
      currency: "¥",
      cabin: cabinLabel(prices[0]?.cabin),
      url: target
    };
    if (!row.airline || !row.flightNo || !row.departureTime || !row.departureAirport || !row.arrivalTime || !row.arrivalAirport || !Number.isFinite(row.price)) {
      common.fail("COMMAND_EXEC", `Malformed flight itinerary at index ${index}`);
    }
    return { row, connecting: legs.length > 1 || segments.some((segment) => Number(segment?.transferCount || 0) > 0), departure: common.clean(first?.departureDateTime), id: String(itinerary.itineraryId) };
  }

  async function flight(params) {
    const values = flightRoute(params, false);
    const target = `https://flights.ctrip.com/online/list/oneway-${values.from.toLowerCase()}-${values.to.toLowerCase()}?depdate=${values.date}&cabin=Y_S_C_F&adult=1&child=0&infant=0`;
    if (!common.sameUrl(target)) {
      await runtime.requestPrivileged("network_capture_start", { pattern: "/international/search/api/search/batchSearch" });
      return common.navigate(target, "已启动航班响应捕获；由宿主等待加载并继续查询。");
    }
    let capture;
    try {
      if (common.hasCaptcha()) assertReady("captcha", "flight");
      capture = await runtime.requestPrivileged("network_capture_read", { waitMs: 12000, finish: true });
      if (common.hasCaptcha()) assertReady("captcha", "flight");
    } catch (error) {
      if (error.code !== "CAPTURE_NOT_STARTED") throw error;
      await runtime.requestPrivileged("network_capture_start", { pattern: "/international/search/api/search/batchSearch" });
      return common.navigate(target, "当前页面早于捕获启动；正在重新加载，由宿主继续查询。");
    }
    // An existing capture session can be empty after an earlier page load.
    // Recover before returning to the Agent; the host bounds these read-only
    // continuations by navigation count and the overall execution deadline.
    if (Array.isArray(capture?.entries) && !capture.entries.some(entry => String(entry?.url || "").includes("/international/search/api/search/batchSearch"))) {
      await runtime.requestPrivileged("network_capture_start", { pattern: "/international/search/api/search/batchSearch" });
      return common.navigate(target, "未捕获到航班响应；重新捕获并由宿主继续查询。");
    }
    const itineraries = parseFlightCaptures(capture?.entries);
    if (!itineraries.length) common.fail("EMPTY_RESULT", `No flights for ${values.from} to ${values.to} on ${values.date}`);
    return itineraries.map((item, index) => mapItinerary(item, target, index)).sort((left, right) => Number(left.connecting) - Number(right.connecting) || left.row.price - right.row.price || left.departure.localeCompare(right.departure) || left.id.localeCompare(right.id)).slice(0, values.limit).map((item, index) => ({ rank: index + 1, ...item.row }));
  }

  window.__ctrip_com_transport = { train, bus, ferry, flight, flightRound };
})();

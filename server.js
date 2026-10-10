const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
let latestAudioFile = null;
let latestAudioContentType = "audio/webm";

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data, null, 2));
}

function isAuthorizedInternalRequest(req) {
  const expectedKey = process.env.ROADSIDE_INTELLIGENCE_API_KEY;
  const suppliedKey = req.headers["x-api-key"];

  if (!expectedKey || typeof suppliedKey !== "string") {
    return false;
  }

  const expected = Buffer.from(expectedKey, "utf8");
  const supplied = Buffer.from(suppliedKey, "utf8");

  if (expected.length !== supplied.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, supplied);
}

function recommendResource(request) {
  const problem = (request.problem || "").toLowerCase();
  const service = (request.service_requested || "").toLowerCase();

  // --------------------------------------------------
  // 1. SAFETY SCREENING
  // Safety concerns must be reviewed before selecting
  // a roadside resource.
  // --------------------------------------------------

  const urgentSafetyTerms = [
    "fire",
    "smoke",
    "injured",
    "injury",
    "collision",
    "crash",
    "trapped",
    "fuel leak",
    "gas leak",
    "in a live lane",
    "blocking traffic",
    "unsafe location",
    "dangerous location"
  ];

  const safetyConcern = urgentSafetyTerms.some(term =>
    problem.includes(term)
  );

  if (safetyConcern) {
    return {
      recommended_resource: "Urgent Human Review",
      primary_capability: "Safety Assessment",
      priority: "Urgent",
      reason: "The reported information contains a potential safety concern. A human assessment is required before selecting a roadside resource.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 2. BATTERY WARNING WHILE DRIVING, THEN VEHICLE DIES
  // A charging-system problem may require a tow.
  // Do not assume the alternator is definitively at fault.
  // --------------------------------------------------

  const batteryWarning =
    problem.includes("battery warning light") ||
    problem.includes("battery light came on") ||
    problem.includes("charging system warning");

  const vehicleDied =
    problem.includes("died while driving") ||
    problem.includes("died while moving") ||
    problem.includes("shut off while driving") ||
    problem.includes("engine died while driving");

  if (batteryWarning && vehicleDied) {
    return {
      recommended_resource: "Tow Vehicle",
      primary_capability: "Vehicle Transport / Charging System Assessment",
      reason: "The vehicle reportedly lost power after a charging-system warning. A tow assessment is recommended rather than assuming a boost or battery replacement will resolve the problem.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 3. FLAT TIRE WITH MISSING LOCKING WHEEL-NUT KEY
  // Based on the reported equipment limitation:
  // a light service vehicle may not be able to change
  // this tire without the required key.
  // --------------------------------------------------

  const flatTire =
    service === "flat_tire" ||
    problem.includes("flat tire") ||
    problem.includes("flat tyre") ||
    problem.includes("punctured tire") ||
    problem.includes("punctured tyre");

  const missingWheelLockKey =
    problem.includes("missing wheel lock key") ||
    problem.includes("missing locking wheel nut key") ||
    problem.includes("no wheel lock key") ||
    problem.includes("no locking wheel nut key") ||
    problem.includes("wheel lock key is missing");

  if (flatTire && missingWheelLockKey) {
    return {
      recommended_resource: "Tow Vehicle",
      primary_capability: "Vehicle Transport / Tire Service Limitation",
      reason: "The reported flat tire requires a locking wheel-nut key that is unavailable. A tow is recommended because the required roadside tire service may not be possible with the available equipment.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 4. FLAT TIRE WITHOUT A CONFIRMED USABLE SPARE
  // Do not assume the vehicle carries a spare tire.
  // --------------------------------------------------

  const noSpare =
    problem.includes("no spare") ||
    problem.includes("does not have a spare") ||
    problem.includes("doesn't have a spare") ||
    problem.includes("spare tire is missing") ||
    problem.includes("spare tyre is missing") ||
    problem.includes("spare is unusable");

  if (flatTire && noSpare) {
    return {
      recommended_resource: "Tow Vehicle",
      primary_capability: "Vehicle Transport / Tire Assessment",
      reason: "A usable spare tire has not been confirmed. A tow assessment is recommended to determine the appropriate way to transport the vehicle.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 5. SINGLE CLICK WITH HEADLIGHTS REMAINING BRIGHT
  // This may indicate a starter or starting-circuit issue.
  // It is not a confirmed diagnosis.
  // --------------------------------------------------

  const singleClick =
    problem.includes("single click") ||
    problem.includes("one click") ||
    problem.includes("clicks once");

  const lightsStayBright =
    problem.includes("headlights stay bright") ||
    problem.includes("headlights remain bright") ||
    problem.includes("lights do not dim") ||
    problem.includes("lights don't dim") ||
    problem.includes("headlights do not dim") ||
    problem.includes("headlights don't dim");

  if (singleClick && lightsStayBright) {
    return {
      recommended_resource: "Tow Vehicle",
      primary_capability: "Starting System Assessment / Vehicle Transport",
      reason: "A single click with lights reportedly remaining bright may indicate a starter or starting-circuit fault. A tow assessment is recommended based on the reported symptoms.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 6. NO-START WITH RAPID CLICKING OR FLASHING DASH
  // A weak battery or electrical connection may be involved.
  // A light service vehicle may be appropriate.
  // --------------------------------------------------

  const rapidClicking =
    problem.includes("rapid clicking") ||
    problem.includes("clicking rapidly") ||
    problem.includes("clicking noise");

  const flashingDash =
    problem.includes("flashing dash lights") ||
    problem.includes("dashboard lights flashing") ||
    problem.includes("dash lights flashing");

  if (rapidClicking || flashingDash) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Battery / Electrical Starting System",
      reason: "Reported clicking or flashing dashboard lights may indicate a battery or electrical starting-system issue that could be assessed roadside.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 7. KEY FOB NOT RECOGNIZED
  // Vehicle-specific instructions may be required.
  // Do not assume the same procedure works for every vehicle.
  // --------------------------------------------------

  if (
    problem.includes("key fob not recognized") ||
    problem.includes("key fob not detected") ||
    problem.includes("key not detected") ||
    problem.includes("key not recognized")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Vehicle Starting / Key Recognition Assessment",
      reason: "The vehicle reportedly does not recognize its key. Vehicle-specific starting instructions or roadside assessment may be required.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 8. KEY WILL NOT TURN
  // A steering-wheel lock is one possible explanation.
  // Do not force the key or steering wheel.
  // --------------------------------------------------

  if (
    problem.includes("key will not turn") ||
    problem.includes("key won't turn") ||
    problem.includes("key will not rotate")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Ignition / Steering Lock Assessment",
      reason: "The key reportedly will not turn. A steering-wheel lock or another ignition-related issue may be involved; vehicle-specific guidance or roadside assessment may be required.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 9. VEHICLE WILL NOT START WITH NO SOUND
  // A battery, electrical, starting-system, or interlock
  // issue may be involved.
  // --------------------------------------------------

  const noStart =
    problem.includes("won't start") ||
    problem.includes("will not start") ||
    problem.includes("will not crank") ||
    problem.includes("won't crank") ||
    problem.includes("does not start") ||
    problem.includes("doesn't start");

  const noSound =
    problem.includes("no noise at all") ||
    problem.includes("no sound at all") ||
    problem.includes("nothing happens when i start") ||
    problem.includes("nothing happens when starting");

  if (noStart && noSound) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Battery / Electrical Starting System",
      reason: "The vehicle reportedly will not start and makes no sound. A roadside assessment may help identify a battery, electrical, starting-system, or starting-interlock issue.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 10. GENERAL NO-START / BATTERY-RELATED SITUATION
  // --------------------------------------------------

  if (
    noStart ||
    problem.includes("dead battery") ||
    problem.includes("battery problem") ||
    problem.includes("battery issue")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Battery / Starting System",
      reason: "The reported no-start or battery-related condition may be serviceable roadside. Further assessment is required before confirming the fault.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 11. FLAT TIRE
  // Further questions may be needed about the spare,
  // wheel-lock key, equipment, and roadside safety.
  // --------------------------------------------------

  if (flatTire) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Tire Service",
      reason: "The reported tire issue may be handled roadside, subject to spare-tire availability, required equipment, and a safety assessment of the location.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 12. VEHICLE LOCKOUT
  // --------------------------------------------------

  if (
    service === "lockout" ||
    problem.includes("locked out") ||
    problem.includes("keys locked inside") ||
    problem.includes("keys locked in the vehicle")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Vehicle Lockout",
      reason: "The reported lockout condition may be handled roadside, depending on the vehicle and available equipment.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 13. FUEL DELIVERY
  // --------------------------------------------------

  if (
    service === "fuel" ||
    problem.includes("out of fuel") ||
    problem.includes("out of gas") ||
    problem.includes("ran out of fuel") ||
    problem.includes("ran out of gas")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Fuel Delivery",
      reason: "The reported fuel issue may be handled roadside, subject to vehicle requirements and a safety assessment.",
      additional_information_needed: true,
      automated_resource_selection: false
    };
  }

  // --------------------------------------------------
  // 14. DEFAULT
  // Unknown situations should not be treated as confirmed
  // tow requirements. A tow assessment is the initial
  // recommendation, with human review as needed.
  // --------------------------------------------------

  return {
    recommended_resource: "Tow Vehicle",
    primary_capability: "Vehicle Transport Assessment",
    reason: "The available information is insufficient to identify a suitable roadside repair. A tow assessment is recommended, with further information or human review as needed.",
    additional_information_needed: true,
    automated_resource_selection: false
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Allow browser-based tools to test the plugin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Roadside assistance webpage
  if (req.method === "GET" && req.url === "/") {
    fs.readFile("index.html", "utf8", (error, html) => {

      if (error) {
        sendJson(res, 500, {
          error: "Unable to load roadside assistance page"
        });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html"
      });

      res.end(html);
    });

    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      status: "healthy"
    });
    return;
  }

    // Protected internal roadside intelligence endpoint
  if (
    req.method === "POST" &&
    req.url === "/api/internal/roadside-request"
  ) {
    if (!isAuthorizedInternalRequest(req)) {
      sendJson(res, 401, {
        received: false,
        error: "Unauthorized"
      });
      return;
    }

    try {
      const requestData = await readRequestBody(req);
      const recommendation = recommendResource(requestData);

      sendJson(res, 200, {
        received: true,
        message: "Internal roadside assessment completed",
        request: requestData,
        pre_dispatch_recommendation: recommendation
      });

    } catch (error) {
      sendJson(res, 400, {
        received: false,
        error: "Invalid JSON request"
      });
    }

    return;
  }

  // Customer-facing roadside request endpoint
  if (
    req.method === "POST" &&
    req.url === "/roadside-request"
  ) {
    try {
      await readRequestBody(req);

      sendJson(res, 200, {
        received: true,
        message: "Roadside request received"
      });

    } catch (error) {
      sendJson(res, 400, {
        received: false,
        error: "Invalid JSON request"
      });
    }

    return;
  }
  
  // Receive and temporarily save vehicle sound recording
  if (req.method === "POST" && req.url === "/upload-audio") {

    const audioData = [];

    req.on("data", chunk => {
      audioData.push(chunk);
    });

    req.on("end", () => {
      try {
        const audioBuffer = Buffer.concat(audioData);

        if (audioBuffer.length === 0) {
          sendJson(res, 400, {
            received: false,
            error: "The uploaded recording was empty."
          });
          return;
        }

        const contentType = (
          req.headers["content-type"] || ""
        ).split(";")[0].toLowerCase();

        const audioFormats = {
          "audio/webm": "webm",
          "audio/mp4": "m4a",
          "audio/ogg": "ogg",
          "audio/wav": "wav",
          "audio/mpeg": "mp3"
        };

        const extension = audioFormats[contentType] || "bin";

        const filePath = path.join(
          "/tmp",
          `vehicle-sound-${Date.now()}.${extension}`
        );

        fs.writeFileSync(filePath, audioBuffer);

        latestAudioFile = filePath;
        latestAudioContentType = contentType || "application/octet-stream";

        console.log(
          `Vehicle sound saved: ${audioBuffer.length} bytes; format: ${latestAudioContentType}`
        );

        sendJson(res, 200, {
          received: true,
          saved: true,
          message: "Vehicle sound temporarily saved",
          size_bytes: audioBuffer.length,
          content_type: latestAudioContentType
        });

      } catch (error) {
        console.error("Audio save failed:", error);

        sendJson(res, 500, {
          received: false,
          error: "Unable to save the audio recording."
        });
      }
    });

    req.on("error", error => {
      console.error("Audio upload failed:", error);
    });

    return;
  }

  
      // Play back the latest saved vehicle recording
      if (req.method === "GET" && req.url === "/latest-audio") {

        if (!latestAudioFile || !fs.existsSync(latestAudioFile)) {
          sendJson(res, 404, {
            error: "No saved recording is available."
          });
          return;
        }

        const extension = path.extname(latestAudioFile);

        res.writeHead(200, {
          "Content-Type": latestAudioContentType || "application/octet-stream",
          "Content-Disposition": `inline; filename=vehicle-sound${extension}`,
          "Content-Length": fs.statSync(latestAudioFile).size
        });

        fs.createReadStream(latestAudioFile).pipe(res);
        return;
      }
  // Unknown route
  sendJson(res, 404, {
    error: "Route not found"
  });
});

server.listen(PORT, () => {
  console.log(`Roadside Intelligence POC running on port ${PORT}`);
});

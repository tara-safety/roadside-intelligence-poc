const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");
const OpenAI = require("openai");

const execFileAsync = promisify(execFile);
console.log("OpenAI API key available:", Boolean(process.env.OPENAI_API_KEY));

async function convertAudioToWav(inputFile) {
  const outputFile = path.join(
    "/tmp",
    `vehicle-sound-${Date.now()}.wav`
  );

  await execFileAsync(ffmpegPath, [
    "-y",
    "-i", inputFile,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    outputFile
  ]);

  return outputFile;
}

async function assessAudioQuality(wavFile) {
  const result = await execFileAsync(ffmpegPath, [
    "-i", wavFile,
    "-af", "silencedetect=noise=-50dB:d=0.5,volumedetect,astats=metadata=1:reset=0",
    "-f", "null",
    "-"
  ]);

  const output = result.stderr || "";

  const meanMatch = output.match(/mean_volume:\s*(-?[\d.]+)\s*dB/i);
  const maxMatch = output.match(/max_volume:\s*(-?[\d.]+)\s*dB/i);
  const rmsMatch = output.match(/RMS level dB:\s*(-?[\d.]+)/i);
  const peakMatch = output.match(/Peak level dB:\s*(-?[\d.]+)/i);

  const silenceDetected = output.includes("silence_start");

  const meanVolume = meanMatch ? Number(meanMatch[1]) : null;
  const maxVolume = maxMatch ? Number(maxMatch[1]) : null;
  const rmsLevel = rmsMatch ? Number(rmsMatch[1]) : null;
  const peakLevel = peakMatch ? Number(peakMatch[1]) : null;

  return {
    audio_measurement_completed: true,
    mean_volume_db: meanVolume,
    maximum_volume_db: maxVolume,
    rms_level_db: rmsLevel,
    peak_level_db: peakLevel,
    silence_detected: silenceDetected,
    clipping_possible: peakLevel !== null && peakLevel >= -0.5,
    measurement_source: "FFmpeg"
  };
}

const PORT = process.env.PORT || 3000;
let latestAudioFile = null;
let latestAudioContentType = "audio/webm";
let latestAudioUploadedAt = null;

// Temporary internal roadside assessment storage
const roadsideAssessments = new Map();

// Temporary audio storage linked to individual roadside requests
const roadsideAudioFiles = new Map();

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

function recommendResourceCore(request) {
  const problem = (request.problem || "").toLowerCase();
  const service = (request.service_requested || "").toLowerCase();

  const audioObservations = request.audio_observations;
  const hasAudioAnalysis =
    audioObservations &&
    typeof audioObservations.observations === "string" &&
    typeof audioObservations.possibilities === "string";
  
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
  // AUDIO OBSERVATIONS
  // Audio can support the assessment, but it cannot
  // confirm a mechanical fault or select a resource alone.
  // --------------------------------------------------

  let audioAssessmentNote = "";

  if (hasAudioAnalysis) {
    audioAssessmentNote =
      " Vehicle sound observations: " +
      audioObservations.observations +
      " Possible explanations (unconfirmed): " +
      audioObservations.possibilities;

    console.log("Vehicle sound observations added to assessment.");
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
audio_assessment_note: audioAssessmentNote || null,
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

function recommendResource(request) {
const recommendation = recommendResourceCore(request);

// Keep urgent safety recommendations unchanged.
if (recommendation.recommended_resource === "Urgent Human Review") {
return recommendation;
}

const audioObservations = request.audio_observations;

const hasAudioAnalysis =
audioObservations &&
typeof audioObservations.observations === "string" &&
typeof audioObservations.possibilities === "string";

const audioAssessmentNote = hasAudioAnalysis
? "Vehicle sound observations: " +
audioObservations.observations +
" Possible explanations (unconfirmed): " +
audioObservations.possibilities
: null;

return {
...recommendation,
audio_assessment_note: audioAssessmentNote
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

  async function analyzeLatestAudio(audioFile = latestAudioFile) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Audio analysis is not configured.");
  }

  if (!audioFile || !fs.existsSync(audioFile)) {
  throw new Error("No saved vehicle recording is available.");
}
  let wavFile = null;

  try {
    const originalSize = fs.statSync(audioFile) .size;

    if (originalSize > 8 * 1024 * 1024) {
      throw new Error("The recording is too large for this test.");
    }

    wavFile = await convertAudioToWav(audioFile);

    const audioQuality = await assessAudioQuality(wavFile);

    const wavSize = fs.statSync(wavFile).size;

    if (wavSize > 10 * 1024 * 1024) {
      throw new Error("The converted recording is too large for this test.");
    }

    const audioBase64 = fs
      .readFileSync(wavFile)
      .toString("base64");

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const response = await openai.chat.completions.create({
      model: "gpt-audio-1.5",
      modalities: ["text"],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "You are assisting with a roadside vehicle assessment.",
                "Analyze the recording and report only what can reasonably be determined from the audible evidence.",
                "Return a valid JSON object with exactly two fields:",
                '{"observations":"Short, factual description of the sounds heard.","possibilities":"Cautious explanation of possible causes, or state that there is insufficient evidence."}',
                "Describe only sounds that can actually be heard.",
                "Do not claim a mechanical fault is confirmed.",
                "Never recommend a dispatch resource based on sound alone.",
                "If the recording is unclear, noisy, or inconclusive, say so.",
                "Return JSON only, without Markdown or extra text."
              ].join(" ")
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: "wav"
              }
            }
          ]
        }
      ],
      max_completion_tokens: 300
    });

    const analysis = response.choices?.[0]?.message?.content;

    if (!analysis || typeof analysis !== "string") {
      throw new Error("The audio model returned no usable description.");
    }

    const structuredAnalysis = JSON.parse(analysis);

    if (
      !structuredAnalysis ||
      typeof structuredAnalysis !== "object" ||
      Array.isArray(structuredAnalysis) ||
      typeof structuredAnalysis.observations !== "string" ||
      typeof structuredAnalysis.possibilities !== "string"
    ) {
      throw new Error("The audio analysis returned an unexpected format.");
    }

    return {
  ...structuredAnalysis,
  audio_quality: audioQuality
};

  } finally {
    if (wavFile && fs.existsSync(wavFile)) {
      try {
        fs.unlinkSync(wavFile);
      } catch (cleanupError) {
        console.error("Temporary audio cleanup failed.");
      }
    }
  }
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

// Protected internal assessment retrieval endpoint
if (
  req.method === "GET" &&
  req.url.startsWith("/api/internal/roadside-assessment")
) {
  if (!isAuthorizedInternalRequest(req)) {
    sendJson(res, 401, {
      received: false,
      error: "Unauthorized"
    });
    return;
  }

  const requestUrl = new URL(
    req.url,
    "http://localhost"
  );

  const requestId = requestUrl.searchParams.get("id");

  if (!requestId) {
    sendJson(res, 400, {
      received: false,
      error: "Request ID is required"
    });
    return;
  }

  const assessment = roadsideAssessments.get(requestId);

  if (!assessment) {
    sendJson(res, 404, {
      received: false,
      error: "Assessment not found"
    });
    return;
  }

  sendJson(res, 200, {
    received: true,
    internal_assessment: assessment
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

      const audioObservations =
        requestData.audio_observations &&
        typeof requestData.audio_observations.observations === "string" &&
        typeof requestData.audio_observations.possibilities === "string"
          ? requestData.audio_observations
          : null;

      const assessmentRequest = {
        ...requestData,
        audio_observations: audioObservations
      };

      const recommendation = recommendResource(assessmentRequest);

      sendJson(res, 200, {
        received: true,
        message: "Internal roadside assessment completed",
        request: requestData,
        audio_assessment_note:
          recommendation.audio_assessment_note || null,
        pre_dispatch_recommendation: recommendation
      });

    } catch (error) {
      console.error(
        "Internal roadside assessment failed:",
        error.message
      );

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
    const requestData = await readRequestBody(req);

    // Generate a unique internal request ID
    const requestId = crypto.randomUUID();

    // Run the existing roadside recommendation engine
    const recommendation = recommendResource(requestData);

  // Compare requested service with the recommended resource

const requestedService =
  (requestData.service_requested || "").toLowerCase();

// Identify the normal resource expected for each service
const expectedResourceByService = {
  tow: "tow",
  battery: "light_service",
  flat_tire: "light_service",
  lockout: "light_service",
  fuel: "light_service"
};

// Determine the expected resource category
const expectedResource =
  expectedResourceByService[requestedService] || null;

// Get the system's recommended resource
const recommendedResource =
  recommendation.recommended_resource || "Not specified";

// Classify the recommended resource
const recommendedResourceText =
  recommendedResource.toLowerCase();

let recommendedResourceCategory = null;

if (recommendedResourceText.includes("tow")) {
  recommendedResourceCategory = "tow";
} else if (recommendedResourceText.includes("light service")) {
  recommendedResourceCategory = "light_service";
}

// Build the internal comparison
const recommendationDiffers =
  expectedResource && recommendedResourceCategory
    ? expectedResource !== recommendedResourceCategory
    : null;

const comparisonExplanation = recommendationDiffers === true
  ? "The recommended resource differs from the resource normally expected for the customer's requested service. Dispatcher review is required before any dispatch decision."
  : recommendationDiffers === false
    ? "The recommended resource matches the resource normally expected for the customer's requested service."
    : "The system could not establish a reliable resource comparison. Dispatcher review is required.";

const resourceComparison = {
  customer_requested_service:
    requestData.service_requested || "Not specified",

  expected_resource_for_request:
    expectedResource || "Not established",

  system_recommended:
    recommendedResource,

  recommendation_differs:
    recommendationDiffers,

  comparison_explanation:
    comparisonExplanation,

  recommendation_reason:
    recommendation.reason || "No explanation provided",

  dispatcher_review_required: true
};

// Store the internal assessment
roadsideAssessments.set(requestId, {
  request_id: requestId,
  received_at: new Date().toISOString(),
  request: requestData,
  resource_comparison: resourceComparison,
  pre_dispatch_recommendation: recommendation
});
    
    // Keep storage manageable during testing
    if (roadsideAssessments.size > 100) {
      const oldestRequestId =
        roadsideAssessments.keys().next().value;

      roadsideAssessments.delete(oldestRequestId);
    }

    console.log("Roadside assessment stored:", requestId);

   // Customer receives confirmation and internal request reference
sendJson(res, 200, {
  received: true,
  message: "Roadside request received",
  request_id: requestId
});

  } catch (error) {
    console.error(
      "Roadside request processing failed:",
      error.message
    );

    sendJson(res, 400, {
      received: false,
      error: "Unable to process roadside request"
    });
  }

  return;
}
  
 // Receive and temporarily save vehicle sound recording
if (
  req.method === "POST" &&
  req.url.startsWith("/upload-audio")
) {

  // Read the roadside request ID from the upload URL
  const uploadUrl = new URL(
    req.url,
    "http://localhost"
  );

  const requestId = uploadUrl.searchParams.get("request_id");

  // A request ID is required
  if (!requestId) {
    sendJson(res, 400, {
      received: false,
      error: "A roadside request ID is required."
    });
    return;
  }

  // Confirm that this roadside request exists
  if (!roadsideAssessments.has(requestId)) {
    sendJson(res, 404, {
      received: false,
      error: "The roadside request could not be found."
    });
    return;
  }

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
        `vehicle-sound-${requestId}-${Date.now()}.${extension}`
      );

      fs.writeFileSync(filePath, audioBuffer);

      // Preserve the existing latest-audio functionality
      latestAudioFile = filePath;
      latestAudioContentType =
        contentType || "application/octet-stream";
      latestAudioUploadedAt = Date.now();

      // Link this recording to its specific roadside request
      roadsideAudioFiles.set(requestId, {
        filePath: filePath,
        contentType: latestAudioContentType,
        uploadedAt: latestAudioUploadedAt
      });

      console.log(
        `Vehicle sound saved for request ${requestId}: ${audioBuffer.length} bytes`
      );

      sendJson(res, 200, {
        received: true,
        saved: true,
        request_id: requestId,
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

// Protected internal vehicle sound analysis endpoint
if (
  req.method === "POST" &&
  req.url.startsWith("/api/internal/analyze-audio")
) {
  if (!isAuthorizedInternalRequest(req)) {
    sendJson(res, 401, {
      received: false,
      error: "Unauthorized"
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 500, {
      received: false,
      error: "Audio analysis is not configured."
    });
    return;
  }

  const analysisUrl = new URL(
    req.url,
    "http://localhost"
  );

  const requestId =
    analysisUrl.searchParams.get("request_id");

  if (!requestId) {
    sendJson(res, 400, {
      received: false,
      error: "A roadside request ID is required."
    });
    return;
  }

  const savedAudio = roadsideAudioFiles.get(requestId);

  if (
    !savedAudio ||
    !savedAudio.filePath ||
    !fs.existsSync(savedAudio.filePath)
  ) {
    sendJson(res, 404, {
      received: false,
      error: "No recording was found for this roadside request."
    });
    return;
  }

  try {
    const structuredAnalysis =
      await analyzeLatestAudio(savedAudio.filePath);

  const assessment = roadsideAssessments.get(requestId);

if (!assessment) {
  sendJson(res, 404, {
    received: false,
    error: "Roadside assessment not found."
  });
  return;
}

assessment.request.audio_observations = structuredAnalysis;

assessment.pre_dispatch_recommendation =
  recommendResource({
    ...assessment.request,
    audio_observations: structuredAnalysis
  });
    
    console.log(
      `Vehicle audio analysis completed for request ${requestId}.`
    );

    sendJson(res, 200, {
      received: true,
      request_id: requestId,
      analysis_type: "vehicle_sound_observation",
      model: "gpt-audio-1.5",
      audio_observations: structuredAnalysis,
      diagnosis_confirmed: false,
      dispatch_decision_made: false
    });

  } catch (error) {
    console.error(
      "Vehicle audio analysis failed:",
      error.message
    );

    sendJson(res, 500, {
      received: false,
      error: "Unable to analyze the recording at this time."
    });
  }

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

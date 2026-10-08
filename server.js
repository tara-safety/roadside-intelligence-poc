const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
let latestAudioFile = null;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data, null, 2));
}

function recommendResource(request) {
  const problem = (request.problem || "").toLowerCase();
  const service = (request.service_requested || "").toLowerCase();

  // No-start / battery-related situation
  if (
    problem.includes("won't start") ||
    problem.includes("will not start") ||
    problem.includes("dead battery") ||
    problem.includes("battery")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Battery / Starting System",
      reason: "Reported no-start condition may be serviceable without a tow."
    };
  }

  // Flat tire
  if (
    service === "flat_tire" ||
    problem.includes("flat tire")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Tire Service",
      reason: "Reported tire issue may be handled roadside."
    };
  }

  // Lockout
  if (
    service === "lockout" ||
    problem.includes("locked") ||
    problem.includes("keys")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Vehicle Lockout",
      reason: "Reported lockout condition may be handled roadside."
    };
  }

  // Fuel
  if (
    service === "fuel" ||
    problem.includes("out of fuel") ||
    problem.includes("out of gas")
  ) {
    return {
      recommended_resource: "Light Service Vehicle",
      primary_capability: "Fuel Delivery",
      reason: "Reported fuel issue may be handled roadside."
    };
  }

  // Default
  return {
    recommended_resource: "Tow Vehicle",
    primary_capability: "Vehicle Transport",
    reason: "Available information indicates a tow assessment is appropriate."
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

  // Mock roadside assistance request
  if (req.method === "POST" && req.url === "/roadside-request") {
    try {

      const requestData = await readRequestBody(req);

      const recommendation = recommendResource(requestData);

sendJson(res, 200, {
  received: true,
  message: "Roadside request received",
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

        const filePath = path.join(
          "/tmp",
          `vehicle-sound-${Date.now()}.webm`
        );

        fs.writeFileSync(filePath, audioBuffer);

        console.log(
          `Vehicle sound saved: ${audioBuffer.length} bytes`
        );

        sendJson(res, 200, {
          received: true,
          saved: true,
          message: "Vehicle sound temporarily saved",
          size_bytes: audioBuffer.length
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
  
  // Unknown route
  sendJson(res, 404, {
    error: "Route not found"
  });
});

server.listen(PORT, () => {
  console.log(`Roadside Intelligence POC running on port ${PORT}`);
});

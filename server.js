const http = require("http");
const fs = require("fs");

const PORT = process.env.PORT || 3000;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data, null, 2));
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

      sendJson(res, 200, {
        received: true,
        message: "Roadside request received",
        request: requestData
      });

    } catch (error) {

      sendJson(res, 400, {
        received: false,
        error: "Invalid JSON request"
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

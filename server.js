const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        project: "Roadside Intelligence POC",
        status: "online"
      })
    );
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "healthy"
      })
    );
    return;
  }

  res.writeHead(404);
  res.end(
    JSON.stringify({
      error: "Route not found"
    })
  );
});

server.listen(PORT, () => {
  console.log(`Roadside Intelligence POC running on port ${PORT}`);
});

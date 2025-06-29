// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const socketIo = require("socket.io");
const socketHandler = require("./src/sockets/SocketHandler");

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIo(server, {
  cors: {
    origin: [
      "http://localhost:4200",
      "http://localhost:3000",
      "http://localhost:3001",
      process.env.FRONTEND_URL,
    ].filter(Boolean),
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Initialize socket handler and get utilities
const socketUtils = socketHandler(io);

// Make socket utilities available to routes
app.set("io", io);
app.set("socketUtils", socketUtils);

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

console.log(`🚀 Starting GlobalChat server in ${NODE_ENV} mode...`);

/**
 * Database Connection
 */
async function connectDatabase() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB connected successfully");
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    process.exit(1);
  }
}

/**
 * Middleware Setup
 */
function setupMiddleware() {
  console.log("🔍 Setting up middleware...");

  // CORS configuration
  app.use(
    require("cors")({
      origin: [
        "http://localhost:4200",
        "http://localhost:3000",
        "http://localhost:3001",
        process.env.FRONTEND_URL,
      ].filter(Boolean),
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    })
  );

  // Body parsing
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const emoji = res.statusCode >= 400 ? "❌" : "✅";
      console.log(
        `${emoji} ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`
      );
    });
    next();
  });

  console.log("✅ Middleware setup complete");
}

/**
 * Routes Setup
 */
function setupRoutes() {
  console.log("🔍 Setting up routes...");

  // Health check routes
  app.get("/", (req, res) => {
    res.json({
      success: true,
      message: "GlobalChat Backend API is running!",
      version: "2.0.0",
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      endpoints: {
        health: "/api/health",
        auth: "/api/auth",
        chat: "/api/chat",
      },
    });
  });

  app.get("/api/health", (req, res) => {
    res.json({
      success: true,
      message: "GlobalChat Backend API is healthy!",
      version: "2.0.0",
      environment: NODE_ENV,
      database:
        mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(
          process.memoryUsage().heapUsed / 1024 / 1024
        )}MB`,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Load auth routes
  try {
    console.log("🔍 Loading auth routes...");
    const authRoutes = require("./src/routes/user.routes");
    app.use("/api/auth", authRoutes);
    console.log("✅ Auth routes loaded successfully");
  } catch (error) {
    console.error("❌ Error loading auth routes:", error.message);

    // Create fallback auth routes
    app.post("/api/auth/register", (req, res) => {
      res
        .status(501)
        .json({ success: false, message: "Auth routes not available" });
    });

    app.post("/api/auth/login", (req, res) => {
      res
        .status(501)
        .json({ success: false, message: "Auth routes not available" });
    });

    app.get("/api/auth/test", (req, res) => {
      res.json({ success: true, message: "Fallback auth test route" });
    });
  }

  // Load chat routes with authentication
  try {
    console.log("🔍 Loading chat routes...");
    const { authenticateToken } = require("./src/middlewares/AuthMiddleware");
    const chatRoutes = require("./src/routes/chat.routes");
    app.use("/api/chat", authenticateToken, chatRoutes);
    console.log("✅ Chat routes loaded successfully");
  } catch (error) {
    console.error("❌ Error loading chat routes:", error.message);

    // Create fallback chat route
    app.get("/api/chat/test", (req, res) => {
      res
        .status(501)
        .json({ success: false, message: "Chat routes not available" });
    });
  }

  // API status endpoint (protected)
  try {
    const { authenticateToken } = require("./src/middlewares/AuthMiddleware");
    app.get("/api/status", authenticateToken, (req, res) => {
      res.json({
        success: true,
        user: req.user
          ? {
              id: req.user._id || req.user.id,
              email: req.user.email,
              firstName: req.user.firstName,
              lastName: req.user.lastName,
            }
          : null,
        server: {
          serverTime: new Date().toISOString(),
          uptime: Math.floor(process.uptime()),
        },
      });
    });
    console.log("✅ Protected status endpoint setup");
  } catch (error) {
    console.warn("⚠️ Protected status endpoint not available");
  }

  console.log("✅ Routes setup complete");
}

/**
 * Express 5.x Compatible Error Handlers
 */
function setupErrorHandlers() {
  console.log("🔍 Setting up Express 5.x compatible error handlers...");

  // Express 5.x compatible 404 handler - NO wildcards
  app.use((req, res, next) => {
    // This runs for any unmatched route
    res.status(404).json({
      success: false,
      message: req.path.startsWith("/api")
        ? "API endpoint not found"
        : "Route not found",
      requestedPath: req.originalUrl,
      method: req.method,
      ...(req.path.startsWith("/api") && {
        availableEndpoints: [
          "GET /api/health",
          "GET /api/status",
          "POST /api/auth/register",
          "POST /api/auth/login",
          "GET /api/auth/test",
          "GET /api/chat/test",
        ],
      }),
      timestamp: new Date().toISOString(),
    });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error("❌ Global error:", {
      message: err.message,
      url: req.originalUrl,
      method: req.method,
      stack: NODE_ENV === "development" ? err.stack : undefined,
    });

    // Handle specific error types
    if (err.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: Object.values(err.errors).map((e) => ({
          field: e.path,
          message: e.message,
          value: e.value,
        })),
      });
    }

    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || "field";
      return res.status(409).json({
        success: false,
        message: `${field} already exists`,
        code: "DUPLICATE_FIELD",
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
        code: "INVALID_TOKEN",
      });
    }

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Authentication token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    // Default error response
    const statusCode = err.statusCode || err.status || 500;
    res.status(statusCode).json({
      success: false,
      message: err.message || "Internal server error",
      code: err.code || "INTERNAL_ERROR",
      timestamp: new Date().toISOString(),
      ...(NODE_ENV === "development" && {
        stack: err.stack,
      }),
    });
  });

  console.log("✅ Express 5.x compatible error handlers setup complete");
}

/**
 * Start Server
 */
async function startServer() {
  try {
    await connectDatabase();
    setupMiddleware();
    setupRoutes();
    setupErrorHandlers(); // Now using Express 5.x compatible handlers

    server.listen(PORT, () => {
      console.log(`\n🎉 GlobalChat server successfully started!`);
      console.log(`📍 Server: http://localhost:${PORT}`);
      console.log(`🏥 Health: http://localhost:${PORT}/api/health`);
      console.log(`🔐 Auth: http://localhost:${PORT}/api/auth/test`);
      console.log(`💬 Chat: http://localhost:${PORT}/api/chat/test`);
      console.log(`🔌 WebSocket: http://localhost:${PORT}/socket.io/`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`📊 PID: ${process.pid}`);
      console.log(
        `📝 Express version: ${require("express/package.json").version}`
      );
      console.log(`⚡ Ready!\n`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`\n📤 Received ${signal}. Starting graceful shutdown...`);

  server.close((err) => {
    if (err) {
      console.error("❌ Error during shutdown:", err);
      process.exit(1);
    }

    mongoose.connection.close(false, () => {
      console.log("🛑 Database connection closed");
      console.log("✅ Graceful shutdown completed");
      process.exit(0);
    });
  });
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start the server
startServer();

module.exports = { app, server };

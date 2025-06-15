require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 3000;

console.log("🚀 Starting server...");

// ✅ Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ MONGO_URI is not defined in environment variables");
  process.exit(1);
}

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected successfully");
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// ✅ Middleware
app.use(
  cors({
    origin: ["http://localhost:4200", "http://localhost:3000"],
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

console.log("✅ Middleware setup complete");

// ✅ Basic routes FIRST (to test server is working)
app.get("/", (req, res) => {
  res.json({ message: "GlobalChat Backend API is running!" });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "GlobalChat Backend API is running!",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/test", (req, res) => {
  res.json({ message: "Backend connected successfully!" });
});

console.log("✅ Basic routes setup complete");

// ✅ Try to import auth routes with error handling
try {
  console.log("🔍 Attempting to import auth routes...");
  const authRoutes = require("./src/routes/user.routes");
  console.log("✅ Auth routes imported successfully");

  // Mount auth routes
  app.use("/api/auth", authRoutes);
  console.log("✅ Auth routes mounted at /api/auth");
} catch (error) {
  console.error("❌ Error importing or mounting auth routes:", error.message);
  console.error("Stack trace:", error.stack);
}

// ✅ Get all users route
app.get("/api/users", async (req, res) => {
  try {
    const User = require("./src/models/User");
    const users = await User.find().select("-password");
    res.json({
      success: true,
      users,
    });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch users",
    });
  }
});

// ✅ 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    requestedPath: req.originalUrl,
  });
});

// ✅ Global error handler
app.use((err, req, res, next) => {
  console.error("Global error:", err);
  res.status(500).json({
    success: false,
    message: "Internal server error",
    ...(process.env.NODE_ENV === "development" && { error: err.message }),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔐 Auth endpoints: http://localhost:${PORT}/api/auth/`);
});

// Export for testing
module.exports = app;

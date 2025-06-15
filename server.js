require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 3000;

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

// ✅ Import routes AFTER middleware setup
const authRoutes = require("./src/routes/user.routes");

// ✅ Routes
app.use("/api/auth", authRoutes);

// ✅ Basic routes
app.get("/api/test", (req, res) => {
  res.json({ message: "Backend connected successfully!" });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "GlobalChat Backend API is running!",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({ message: "GlobalChat Backend API is running!" });
});

// ✅ Get all users (for admin purposes - consider protecting this route)
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

// ✅ Serve Angular frontend (in production)
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "dist/your-angular-app")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist/your-angular-app/index.html"));
  });
}

// ✅ 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
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

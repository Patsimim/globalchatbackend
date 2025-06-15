const express = require("express");
const router = express.Router();

console.log("🔍 Loading auth routes...");

// Try to import controllers with error handling
let register, login, getProfile;
try {
  const authController = require("../controllers/AuthController");
  register = authController.register;
  login = authController.login;
  getProfile = authController.getProfile;
  console.log("✅ Auth controllers imported successfully");
} catch (error) {
  console.error("❌ Error importing auth controllers:", error.message);
  throw error;
}

// Try to import middleware with error handling
let authenticateToken;
try {
  const authMiddleware = require("../middlewares/AuthMiddleware");
  authenticateToken = authMiddleware.authenticateToken;
  console.log("✅ Auth middleware imported successfully");
} catch (error) {
  console.error("❌ Error importing auth middleware:", error.message);
  throw error;
}

// Define routes with explicit paths (no parameters that could cause issues)
console.log("🔗 Setting up routes...");

// POST /api/auth/register
router.post("/register", (req, res, next) => {
  console.log("📝 Register endpoint hit");
  register(req, res, next);
});

// POST /api/auth/login
router.post("/login", (req, res, next) => {
  console.log("🔑 Login endpoint hit");
  login(req, res, next);
});

// GET /api/auth/profile (protected route)
router.get("/profile", authenticateToken, (req, res, next) => {
  console.log("👤 Profile endpoint hit");
  getProfile(req, res, next);
});

// Test route to ensure router is working
router.get("/test", (req, res) => {
  console.log("🧪 Auth test endpoint hit");
  res.json({
    success: true,
    message: "Auth routes are working!",
    timestamp: new Date().toISOString(),
  });
});

console.log("✅ Auth routes setup complete");

module.exports = router;

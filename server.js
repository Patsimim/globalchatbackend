// server.js
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = 3000;

// Middleware
app.use(cors()); // Enable CORS for Angular requests
app.use(express.json()); // Parse JSON bodies

// Sample routes
app.get("/api/users", (req, res) => {
  res.json([
    { id: 1, name: "John Doe" },
    { id: 2, name: "Jane Smith" },
  ]);
});

app.post("/api/users", (req, res) => {
  const newUser = req.body;
  // Process the user data
  res.json({ message: "User created", user: newUser });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// seed.js
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./src/models/User");

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(uri);

const db = mongoose.connection;

db.on("error", console.error.bind(console, "connection error:"));
db.once("open", async () => {
  console.log("MongoDB connected for seeding.");

  try {
    // Clear existing users
    await User.deleteMany();

    // Dummy users
    const dummyUsers = [
      { name: "Alice Johnson", email: "alice@example.com" },
      { name: "Bob Smith", email: "bob@example.com" },
      { name: "Charlie Lee", email: "charlie@example.com" },
    ];

    // Insert dummy users
    await User.insertMany(dummyUsers);

    console.log("✅ Dummy users seeded!");
    process.exit(); // Exit after seeding
  } catch (error) {
    console.error("❌ Error seeding users:", error);
    process.exit(1);
  }
});

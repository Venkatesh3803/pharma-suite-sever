import mongoose from "mongoose";
import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import { errorHandler } from "./src/utils/error-handler";
import authanticationRoutes from "./src/routes/authantication";

dotenv.config();

const app = express();

app.use(express.json({ limit: "30mb" }));
app.use(bodyParser.urlencoded({ limit: "30mb", extended: true }));
app.use(
  cors({
    origin: "http://localhost:3001",
  }),
);

const port = process.env.PORT || 5000;
const mongoUrl = process.env.MONGO_URL;

if (!mongoUrl) {
  console.error("Error: MONGO_URL is not defined in .env file.");
  process.exit(1);
}

app.use(errorHandler);

mongoose
  .connect(mongoUrl)
  .then(() => {
    console.log("Connected to MongoDB successfully");
    app.listen(port, () => console.log(`Server running on port ${port}`));
  })
  .catch(error => {
    console.error("MongoDB connection error:", error);
  });

app.use("/api", authanticationRoutes);

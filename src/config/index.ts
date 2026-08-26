import dotenv from "dotenv";

dotenv.config();

export const config = {
    env: process.env.NODE_ENV || "development",
    port: parseInt(process.env.PORT || "5000", 10),
    jwtSecret: process.env.JWT_SECRET || "dev-secret",
    corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
    uploadDir: process.env.UPLOAD_DIR || "uploads",
    brevoApiKey: process.env.BREVO_API_KEY || "",
    mailFromEmail:
        process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM_EMAIL || "pharmasuite@localhost",
    mailFromName: process.env.BREVO_SENDER_NAME || process.env.MAIL_FROM_NAME || "PharmaSuite"
};

import dotenv from "dotenv";

dotenv.config();

function requireEnvInProduction(name: string, fallback: string): string {
    const value = process.env[name] || fallback;
    if (process.env.NODE_ENV === "production" && !process.env[name]) {
        throw new Error(`[config] ${name} must be set in production. Refusing to boot with an insecure default.`);
    }
    return value;
}

const accessSecret = requireEnvInProduction(
    "JWT_ACCESS_SECRET",
    process.env.JWT_SECRET || "dev-access-secret-insecure",
);
const refreshSecret = requireEnvInProduction(
    "JWT_REFRESH_SECRET",
    process.env.JWT_SECRET || "dev-refresh-secret-insecure",
);

if (process.env.NODE_ENV === "production" && accessSecret === refreshSecret) {
    throw new Error("[config] JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ in production.");
}

export const config = {
    env: process.env.NODE_ENV || "development",
    port: parseInt(process.env.PORT || "5000", 10),
    jwtSecret: process.env.JWT_SECRET || "dev-secret",
    jwtAccessSecret: accessSecret,
    jwtRefreshSecret: refreshSecret,
    corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
    uploadDir: process.env.UPLOAD_DIR || "uploads",
    brevoApiKey: process.env.BREVO_API_KEY || "",
    mailFromEmail:
        process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM_EMAIL || "pharmasuite@localhost",
    mailFromName: process.env.BREVO_SENDER_NAME || process.env.MAIL_FROM_NAME || "PharmaSuite"
};

// Loads demo data during a deploy only when SEED_DEMO=true. Safe to run repeatedly.
import { execSync } from "node:child_process";
if (process.env.SEED_DEMO === "true") {
  execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });
} else {
  console.log("SEED_DEMO is not true; skipping demo data.");
}

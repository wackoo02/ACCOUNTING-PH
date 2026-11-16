// Apply database migrations during a deploy. Uses the direct (unpooled) connection when the
// host provides one (Neon on Vercel sets DATABASE_URL_UNPOOLED), since migrations need it.
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
if (!url) {
  console.error(
    "\nNo database is connected. In Vercel open the project → Storage → Create Database → Neon (Postgres),\n" +
    "connect it to this project, then redeploy. (Looked for DATABASE_URL / DATABASE_URL_UNPOOLED.)\n",
  );
  process.exit(1);
}
execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

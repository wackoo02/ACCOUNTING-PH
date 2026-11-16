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
const env = { ...process.env, DATABASE_URL: url };

// Migrations written to be safe to re-run. If a deploy stopped partway through one of them,
// Prisma blocks all later deploys (error P3009); marking it rolled back lets it run again.
const RERUNNABLE = ["20261116031500_cash_and_bank", "20261116060000_receivables", "20261116062457_inventory", "20261116062647_debt", "20261116070000_ap_and_purchasing", "20261116070000_saved_reports", "20261116090000_sales_inventory", "20261116200000_fixed_assets", "20261116210000_ap_inbox_per_company"];
for (const name of RERUNNABLE) {
  try {
    execSync(`npx prisma migrate resolve --rolled-back ${name}`, { stdio: "pipe", env });
    console.log(`Retrying migration ${name}, which had stopped partway on an earlier deploy.`);
  } catch {
    // Not in a failed state (already applied or not yet run): nothing to do.
  }
}

execSync("npx prisma migrate deploy", { stdio: "inherit", env });

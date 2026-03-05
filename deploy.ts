import { cpSync, existsSync, readFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";

const PLUGIN_ID = "claude-sidebar-ide";
const FILES = ["main.js", "manifest.json", "styles.css"];

function getObsidianVaults(): { path: string; name: string }[] {
  const configPath = join(
    process.env.HOME!,
    "Library/Application Support/obsidian/obsidian.json"
  );
  if (!existsSync(configPath)) return [];
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return Object.values(config.vaults as Record<string, { path: string }>).map(
    (v) => ({ path: v.path, name: v.path.split("/").pop()! })
  );
}

function deployTo(dest: string, label: string) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const file of FILES) {
    if (existsSync(file)) {
      cpSync(file, resolve(dest, file));
    }
  }
  console.log(`  Deployed to ${label} (${dest})`);
}

// Allow explicit override
if (process.env.OBSIDIAN_PLUGIN_DIR) {
  deployTo(process.env.OBSIDIAN_PLUGIN_DIR, "custom");
} else {
  const vaults = getObsidianVaults();
  if (vaults.length === 0) {
    console.error("No Obsidian vaults found.");
    console.error("Set OBSIDIAN_PLUGIN_DIR to deploy manually.");
    process.exit(1);
  }

  // Deploy to vaults that already have the plugin installed, or all vaults with --all
  const deployAll = process.argv.includes("--all");
  const targets = vaults.filter(
    (v) => deployAll || existsSync(join(v.path, ".obsidian/plugins", PLUGIN_ID))
  );

  if (targets.length === 0) {
    console.log("Plugin not installed in any vault. Available vaults:");
    for (const v of vaults) {
      console.log(`  - ${v.name} (${v.path})`);
    }
    console.log("\nUse --all to deploy to all vaults, or install the plugin in Obsidian first.");
    process.exit(1);
  }

  for (const v of targets) {
    deployTo(join(v.path, ".obsidian/plugins", PLUGIN_ID), v.name);
  }
}

console.log("Reload Obsidian (Cmd+R) to pick up changes.");

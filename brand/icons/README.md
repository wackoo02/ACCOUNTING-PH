# Veritus icon set

59 duotone line icons (24px grid, 1.75 stroke, round caps). The orange strokes use the accent colour #FF6B1A, and the rest use ink #1E1338 (or white on dark backgrounds).

- Source of truth: `src/lib/icons.ts`. Edit it there, then run `npx tsx scripts/export-icons.ts`.
- `light/*.svg` and `dark/*.svg` are ready-made files for the mobile app or for documents.
- `icons.json` holds the raw stroke data (each stroke is `{ d, a }`, where `a` = accent). React Native can render it with `react-native-svg` the same way `src/components/Icon.tsx` does.
- `preview.html` is a contact sheet of every icon.

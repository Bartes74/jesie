import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const localised = z.object({ pl: z.string().min(1).max(400), en: z.string().min(1).max(400) }).strict();
export const themePaletteSchema = z.object({
  background: hex, surface: hex, text: hex, muted: hex, accent: hex, accentText: hex, border: hex,
  heroBackground: hex, catalogBackground: hex, photoBackground: hex, panelBackground: hex, heading: hex,
}).strict();
export const themeProposalSchema = z.object({
  palette: themePaletteSchema, decorationOpacity: z.number().min(0).max(0.18),
  heroPrompt: z.string().min(20).max(6000), atmospherePrompt: z.string().min(20).max(6000),
  accentPrompts: z.object({ corner: z.string().min(20).max(3000), garland: z.string().min(20).max(3000), spot: z.string().min(20).max(3000) }).strict(),
  heroAlt: localised, atmosphereAlt: localised,
}).strict();
export type ThemeProposal = z.infer<typeof themeProposalSchema>;

function luminance(hexColor: string) {
  const values = [1, 3, 5].map(offset => parseInt(hexColor.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
export function themeContrast(a: string, b: string) {
  const left = luminance(a), right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}
const readable = (foreground: string, backgrounds: string[], minimum = 4.5) => {
  if (backgrounds.every(background => themeContrast(foreground, background) >= minimum)) return foreground;
  // Black and white cover even a middle-luminance accent where brand colours fail.
  return ['#203f32', '#17251e', '#faf8f2', '#ffffff', '#000000'].find(candidate =>
    backgrounds.every(background => themeContrast(candidate, background) >= minimum)) ?? '#000000';
};
/** Every body surface uses the same luminance family, allowing one readable text colour. */
export function accessibleThemeProposal(input: unknown): ThemeProposal {
  const result = themeProposalSchema.parse(input);
  const palette = { ...result.palette };
  const isDark = luminance(palette.surface) < 0.18;
  for (const field of ['background', 'heroBackground', 'catalogBackground', 'photoBackground', 'panelBackground'] as const) {
    if ((luminance(palette[field]) < 0.18) !== isDark) palette[field] = palette.surface;
  }
  const backgrounds = [palette.background, palette.surface, palette.heroBackground, palette.catalogBackground, palette.photoBackground, palette.panelBackground];
  palette.text = readable(palette.text, backgrounds);
  // A malformed generated palette cannot leave unreadable secondary text behind.
  if (backgrounds.some(background => themeContrast(palette.text, background) < 4.5)) {
    for (const field of ['background', 'surface', 'heroBackground', 'catalogBackground', 'photoBackground', 'panelBackground'] as const) palette[field] = '#faf8f2';
    palette.text = '#203f32';
  }
  const correctedBackgrounds = [palette.background, palette.surface, palette.heroBackground, palette.catalogBackground, palette.photoBackground, palette.panelBackground];
  palette.muted = readable(palette.muted, correctedBackgrounds);
  palette.heading = readable(palette.heading, correctedBackgrounds);
  palette.accentText = readable(palette.accentText, [palette.accent]);
  return { ...result, palette };
}

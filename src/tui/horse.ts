// 赤兔 — red horse head pixel art for terminal welcome
// Full-block characters + ANSI true color. Forward-facing, symmetrical.
const R = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const BG = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;
const RS = "\x1b[0m";

// Palette
const SKIN = R(200, 40, 35);       // 赤红 — main coat
const DARK = R(140, 25, 20);       // 暗红 — shadow / nostril
const LIGHT = R(235, 80, 60);      // 亮红 — highlight
const MANE = R(170, 30, 20);       // 鬃毛 — darker mane
const BLAZE = R(255, 230, 210);    // 鼻梁白斑
const EYE = R(30, 30, 30);         // 眼 — dark
const EYE_HL = R(255, 255, 255);   // 眼光
const EAR_IN = R(255, 170, 150);   // 耳内

/*
    Forward-facing horse head, ~70 cols wide
    Ears · Eyes · Blaze · Nostrils · Muzzle
    Block chars: █ ▓ ▒ ░  for depth
*/

const H = [
  // 00-01: ear tips
  `                             ${SKIN}░░${LIGHT}▒▒${RS}`,
  `                           ${SKIN}░░${LIGHT}▒▒${SKIN}██${LIGHT}▒▒${RS}`,
  // 02-03: ears with forehead bridge emerging
  `                       ${SKIN}░░${LIGHT}▒▒${SKIN}████${LIGHT}▒▒${SKIN}░░${RS}`,
  `                    ${SKIN}░░${LIGHT}▒▒${SKIN}██${EAR_IN}▓▓${SKIN}██${EAR_IN}▓▓${SKIN}██${LIGHT}▒▒${SKIN}░░${RS}`,
  // 04-05: forehead starts, ears full
  `                  ${SKIN}░░${LIGHT}▒▒${SKIN}████${LIGHT}▒▒${SKIN}██${LIGHT}▒▒${SKIN}████${LIGHT}▒▒${RS}`,
  `                ${SKIN}░░${LIGHT}▒▒${SKIN}██████${MANE}▓▓${LIGHT}▒▒${LIGHT}▒▒${MANE}▓▓${SKIN}██████${LIGHT}▒▒${RS}`,
  // 06-07: eyes appear
  `              ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓▓▓${LIGHT}▒▒${EYE}██${LIGHT}▒▒${MANE}▓▓▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `            ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██${MANE}▓▓${EYE}████${MANE}▓▓${SKIN}██${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  // 08-10: cheeks, full eyes
  `          ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}████${MANE}▓▓${EYE}██${EYE_HL}██${EYE}██${MANE}▓▓${SKIN}████${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `         ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██████${MANE}▓▓${EYE}██${EYE_HL}██${EYE}██${MANE}▓▓${SKIN}██████${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `        ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}████████${MANE}▓▓▓▓${EYE}██${EYE_HL}██${EYE}██${MANE}▓▓▓▓${SKIN}████████${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  // 11-13: nose bridge, blaze begins
  `       ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██████${BLAZE}████████${LIGHT}▒▒${LIGHT}▒▒${BLAZE}████████${SKIN}██████${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `      ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}████${BLAZE}██████████${LIGHT}▒▒${BLAZE}██████████${SKIN}████${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `     ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██${BLAZE}██████████████${BLAZE}██████████████${SKIN}██${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  // 14-16: muzzle widens, nostrils
  `    ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██${BLAZE}████████${SKIN}░░░░${LIGHT}▒▒${LIGHT}▒▒${SKIN}░░░░${BLAZE}████████${SKIN}██${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `   ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██${BLAZE}██████${SKIN}░░░░${DARK}▓▓▓▓${LIGHT}▒▒${DARK}▓▓▓▓${SKIN}░░░░${BLAZE}██████${SKIN}██${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `  ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██${BLAZE}████${SKIN}░░░░${DARK}▓▓▓▓▓▓${DARK}▓▓▓▓${DARK}▓▓▓▓${DARK}▓▓▓▓▓▓${SKIN}░░░░${BLAZE}████${SKIN}██${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  // 17-19: lower muzzle, chin
  ` ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██${BLAZE}████${SKIN}░░${DARK}▓▓▓▓▓▓${SKIN}██${LIGHT}▒▒${DARK}▓▓${LIGHT}▒▒${SKIN}██${DARK}▓▓▓▓▓▓${SKIN}░░${BLAZE}████${SKIN}██${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  ` ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}████${SKIN}░░░░${DARK}▓▓▓▓${SKIN}████████████████${DARK}▓▓▓▓${SKIN}░░░░${SKIN}████${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}████${SKIN}░░${DARK}▓▓▓▓${SKIN}████████████████████${DARK}▓▓▓▓${SKIN}░░${SKIN}████${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  // 20-22: chin and jaw
  `${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${SKIN}██${SKIN}░░${DARK}▓▓${SKIN}████████████████████████${DARK}▓▓${SKIN}░░${SKIN}██${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  ` ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓▓▓${MANE}▓▓${SKIN}████████████████████████${MANE}▓▓${MANE}▓▓▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `  ${SKIN}░░${LIGHT}▒▒${SKIN}████████████████████████████████${SKIN}████████████${LIGHT}▒▒${RS}`,
  `    ${SKIN}░░${LIGHT}▒▒${SKIN}████████████████████████████████${SKIN}████████${LIGHT}▒▒${RS}`,
  `      ${SKIN}░░${LIGHT}▒▒${SKIN}████████████████████████████████${LIGHT}▒▒${RS}`,
  `        ${SKIN}░░${LIGHT}▒▒${SKIN}██████████████████████████${LIGHT}▒▒${RS}`,
  `          ${SKIN}░░${LIGHT}▒▒${SKIN}████████████████████${LIGHT}▒▒${RS}`,
  `            ${SKIN}░░${LIGHT}▒▒${SKIN}████████████${LIGHT}▒▒${RS}`,
  `              ${SKIN}░░${LIGHT}▒▒░░${LIGHT}▒▒░░${LIGHT}▒▒░░${RS}`,
];

export function renderHorse(): string {
  return H.join("\n");
}

// Compact variant for terminals < 70 cols
const H_SMALL = [
  `                ${SKIN}░░${RS}`,
  `              ${SKIN}░░${LIGHT}▒▒${SKIN}░░${RS}`,
  `          ${SKIN}░░${LIGHT}▒▒${EAR_IN}▓▓${SKIN}██${LIGHT}▒▒${RS}`,
  `        ${SKIN}░░${LIGHT}▒▒${SKIN}████${LIGHT}▒▒${LIGHT}▒▒${SKIN}████${LIGHT}▒▒${RS}`,
  `      ${SKIN}░░${LIGHT}▒▒${SKIN}██${MANE}▓▓${EYE}██${MANE}▓▓${SKIN}██${LIGHT}▒▒${RS}`,
  `     ${SKIN}░░${LIGHT}▒▒${SKIN}████${MANE}▓▓${EYE}${EYE_HL}${EYE}${MANE}▓▓${SKIN}████${LIGHT}▒▒${RS}`,
  `    ${SKIN}░░${LIGHT}▒▒${SKIN}██████${BLAZE}████${SKIN}██████${LIGHT}▒▒${RS}`,
  `   ${SKIN}░░${LIGHT}▒▒${SKIN}████${BLAZE}████████${BLAZE}████${SKIN}████${LIGHT}▒▒${RS}`,
  `  ${SKIN}░░${LIGHT}▒▒${SKIN}████${BLAZE}██${SKIN}░░${DARK}▓▓${SKIN}░░${BLAZE}██${SKIN}████${LIGHT}▒▒${RS}`,
  ` ${SKIN}░░${LIGHT}▒▒${SKIN}████${SKIN}░░${DARK}▓▓▓▓${SKIN}████${DARK}▓▓▓▓${SKIN}░░${SKIN}████${LIGHT}▒▒${RS}`,
  `${SKIN}░░${LIGHT}▒▒${SKIN}████${SKIN}░░${DARK}▓▓${SKIN}████████${DARK}▓▓${SKIN}░░${SKIN}████${LIGHT}▒▒${RS}`,
  ` ${SKIN}░░${LIGHT}▒▒${SKIN}████████████████████${LIGHT}▒▒${RS}`,
  `  ${SKIN}░░${LIGHT}▒▒${SKIN}████████████████${LIGHT}▒▒${RS}`,
  `    ${SKIN}░░${LIGHT}▒▒${SKIN}██████████${LIGHT}▒▒${RS}`,
  `      ${SKIN}░░${LIGHT}▒▒░░${LIGHT}▒▒░░${LIGHT}▒▒░░${RS}`,
];

export function renderHorseSmall(): string {
  return H_SMALL.join("\n");
}

export const HORSE_HEIGHT = H.length;
export const HORSE_SMALL_HEIGHT = H_SMALL.length;

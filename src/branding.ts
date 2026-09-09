import figlet from "figlet";

export const FARAI_BANNER = renderFaraiBanner();
export const FARAI_BANNER_LINES = FARAI_BANNER.split("\n");

let bannerPrinted = false;

export function printBannerOnce(): void {
  if (bannerPrinted) return;
  bannerPrinted = true;
  console.log(FARAI_BANNER);
}

export function clearBannerIfShown(): void {
  if (!bannerPrinted || !process.stdout.isTTY) return;
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

function renderFaraiBanner(): string {
  try {
    return figlet.textSync("farai", { font: "Ogre" }).trimEnd();
  } catch {
    return "farai";
  }
}

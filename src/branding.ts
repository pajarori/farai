import figlet from "figlet";

export const FARAI_BANNER = renderFaraiBanner();
export const FARAI_BANNER_LINES = FARAI_BANNER.split("\n");

function renderFaraiBanner(): string {
  try {
    return figlet.textSync("farai", { font: "Ogre" }).trimEnd();
  } catch {
    return "farai";
  }
}

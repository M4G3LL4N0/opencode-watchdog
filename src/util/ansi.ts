const noColor = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

export const cross = noColor ? "" : "\x1b[0m";

export default function colorize(color: "red" | "green" | "yellow" | "cyan" | "bold"): string {
  if (noColor) return "";
  switch (color) {
    case "red":
      return "\x1b[31m";
    case "green":
      return "\x1b[32m";
    case "yellow":
      return "\x1b[33m";
    case "cyan":
      return "\x1b[36m";
    case "bold":
      return "\x1b[1m";
    default:
      return cross;
  }
}
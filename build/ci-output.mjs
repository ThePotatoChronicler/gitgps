import { appendFileSync } from "node:fs"; 

const output = process.env["GITHUB_OUTPUT"];
if (output) {
  appendFileSync(output, `vsixPath=dist/gitgps.vsix\n`)
}

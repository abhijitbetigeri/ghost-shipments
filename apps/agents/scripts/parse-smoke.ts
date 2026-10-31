import { parsePage } from "../src/parse.ts"
console.log(await parsePage("@rover check bay B for SHP-1042, truck leaves at 6"))
console.log(await parsePage("@rover cycle count bay d, shp-2001 P2"))

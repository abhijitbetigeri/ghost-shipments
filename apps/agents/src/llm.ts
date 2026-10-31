// Shared Mastra helpers. Model string "openai/<TEXT_MODEL>", needs OPENAI_API_KEY.
import "./env.ts"
export const TEXT_MODEL = `openai/${process.env.TEXT_MODEL || "gpt-5.5"}`

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let t: ReturnType<typeof setTimeout>
    return Promise.race([
        p,
        new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))),
    ]).finally(() => clearTimeout(t))
}

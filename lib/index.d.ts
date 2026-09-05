import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
declare const name = "notion";
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<{
  mcpUrl: z<string, string>;
  port: z<number, number>;
}>, Schemastery.ObjectT<{
  mcpUrl: z<string, string>;
  port: z<number, number>;
}>>;
type Cfg = {
  mcpUrl: string;
  port: number;
};
declare function apply(ctx: Context, config: Cfg): void;
//#endregion
export { Config, apply, inject, name };
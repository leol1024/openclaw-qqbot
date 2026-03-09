import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { qqbotPlugin } from "./src/channel.js";
import { setQQBotRuntime } from "./src/runtime.js";
import { registerGuildTools } from "./src/tools/guild-list.js";
import { registerChannelTools } from "./src/tools/channel-list.js";
import { registerGuildAnnouncesTool } from "./src/tools/guild-announces.js";
import { registerGuildMemberTools } from "./src/tools/guild-member.js";
// import { registerScheduleTools } from "./src/tools/schedule.js";
import { registerForumThreadTools } from "./src/tools/forum-thread.js";

const plugin = {
  id: "openclaw-qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQBotRuntime(api.runtime);
    api.registerChannel({ plugin: qqbotPlugin });
    registerGuildTools(api);
    registerChannelTools(api);
    registerGuildAnnouncesTool(api);
    registerGuildMemberTools(api);
    // registerScheduleTools(api);
    registerForumThreadTools(api);
  },
};

export default plugin;

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
export { qqbotOnboardingAdapter } from "./src/onboarding.js";
export * from "./src/types.js";
export * from "./src/api.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";

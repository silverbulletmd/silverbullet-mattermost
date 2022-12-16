import { readSecret } from "$sb/lib/secrets_page.ts";
import { readSetting } from "$sb/lib/settings_page.ts";
import { Client4 } from "./deps.ts";

export type MattermostSettings = {
  [serverName: string]: ServerConfig;
};

export type ServerConfig = {
  url: string;
  defaultTeam?: string;
};

export type ServerSecrets = {
  // serverName: token
  [serverName: string]: string;
};

export function mattermostUrlForPost(
  url: string,
  teamName: string,
  postId: string,
  desktop = false,
) {
  return `${
    // For a desktop URL let's replace `https://` with `mattermost://`
    desktop
      ? url.replace("https://", "mattermost://")
      : url}/${teamName}/pl/${postId}`;
}

export async function getServerConfigForUrl(
  url: string,
): Promise<{ name: string; config: ServerConfig }> {
  const mattermostServers: MattermostSettings =
    (await readSetting("mattermost", {}));
  const rootServerUrl = url.split("/").slice(0, 3).join("/");
  for (
    const [serverName, serverConfig] of Object.entries(mattermostServers)
  ) {
    if (serverConfig.url === rootServerUrl) {
      return {
        name: serverName,
        config: serverConfig,
      };
    }
  }
  throw new Error(`No server found for ${url}`);
}

export async function loadMattermostConfig() {
  const mattermostServers: MattermostSettings = await readSetting(
    "mattermost",
    {},
  );
  const mattermostSecrets: ServerSecrets = await readSecret("mattermost");
  return { mattermostServers, mattermostSecrets };
}

export async function getMattermostClientForServer(
  serverName: string,
): Promise<{
  client: Client4;
  config: ServerConfig;
}> {
  const { mattermostServers, mattermostSecrets } = await loadMattermostConfig();
  const serverConfig = mattermostServers[serverName];
  if (!serverConfig) {
    throw new Error(`No server found for ${serverName}`);
  }
  // Instantiate client
  const client = new Client4();
  client.setUrl(serverConfig.url);
  client.setToken(mattermostSecrets[serverName]);
  return { client, config: serverConfig };
}

export function extractPostUrl(
  line: string,
): { serverUrl: string; postId: string } {
  const match = /(https?:\/\/[^\/]+)(.*)\/pl\/(\w+)/.exec(line);
  if (match) {
    return {
      serverUrl: match[1],
      postId: match[3],
    };
  } else {
    throw new Error("Could not extract post URL from line");
  }
}

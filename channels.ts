import { Client4 } from "./deps.ts";

import { CachingClient4 } from "./mattermost_client.ts";
import { readSecrets } from "$sb/lib/secrets_page.ts";
import {
  extractFrontmatter,
  prepareFrontmatterDispatch,
} from "$sb/lib/frontmatter.ts";
import { niceDate } from "$sb/lib/dates.ts";
import { flashNotification } from "$sb/silverbullet-syscall/editor.ts";
import type { PublishEvent, QueryProviderEvent } from "$sb/app_event.ts";
import {
  invokeCommand,
  invokeFunction,
} from "$sb/silverbullet-syscall/system.ts";
import { getCursor, getText } from "$sb/silverbullet-syscall/editor.ts";

import { applyQuery } from "$sb/lib/query.ts";
import { readYamlPage } from "$sb/lib/yaml_page.ts";
import {
  editor,
  markdown,
  space,
  system,
} from "$sb/silverbullet-syscall/mod.ts";
import { renderToText } from "$sb/lib/tree.ts";

type AugmentedPost = {
  // Dates we can use to filter
  createdAt: string;
  updatedAt: string;
  editedAt: string;
} & any;

// https://community.mattermost.com/private-core/pl/rbp7a7jtr3f89nzsefo6ftqt3o

function mattermostUrlForPost(
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

function augmentPost(post: AugmentedPost) {
  if (post.create_at) {
    post.createdAt = niceDate(new Date(post.create_at));
  }
  if (post.update_at) {
    post.updatedAt = niceDate(new Date(post.update_at));
  }
  if (post.edit_at) {
    post.editedAt = niceDate(new Date(post.edit_at));
  }
}

export async function savedPostsQueryProvider({
  query,
}: QueryProviderEvent): Promise<any[]> {
  const serverFilter = query.filter.find((f) => f.prop === "server");
  if (!serverFilter) {
    throw Error("No 'server' filter specified, this is mandatory");
  }
  const serverName = serverFilter.value;
  const { client, config } = await getMattermostClientForServer(serverName);
  const cachingClient = new CachingClient4(client);
  const me = await client.getMe();
  const postCollection = await client.getFlaggedPosts(me.id);

  console.log("Got posts", postCollection);

  let savedPosts: AugmentedPost[] = [];
  for (const order of postCollection.order) {
    const post = postCollection.posts[order];
    augmentPost(post);
    savedPosts.push(post);
  }
  if (!query.limit) {
    query.limit = 15;
  }
  savedPosts = savedPosts.slice(0, query.limit);

  let resultSavedPosts: any[] = [];
  // Let's parallelize additional fetching of post details
  await Promise.all(
    savedPosts.map(async (savedPost) => {
      const channel = await cachingClient.getChannelCached(
        savedPost.channel_id,
      );
      let teamName = config.defaultTeam!;
      if (channel.team_id) {
        const team = await cachingClient.getTeam(channel.team_id);
        teamName = team.name;
      }
      resultSavedPosts.push({
        ...savedPost,
        username: (await cachingClient.getUserCached(savedPost.user_id))
          .username,
        channelName: channel.display_name,
        teamName: teamName,
        server: serverName,
        url: mattermostUrlForPost(client.url, teamName, savedPost.id, false),
        desktopUrl: mattermostUrlForPost(
          client.url,
          teamName,
          savedPost.id,
          true,
        ),
      });
    }),
  );
  resultSavedPosts = applyQuery(query, resultSavedPosts);
  return resultSavedPosts;
}

export async function unsavePostCommand() {
  // Fetch server configs
  const allSettings = (await readYamlPage("SETTINGS", ["yaml"])) || {};
  if (!allSettings.mattermost) {
    throw new Error(`No mattermost settings found`);
  }
  const mattermostServers: MattermostSettings = allSettings.mattermost;

  const text = await getText();
  let startLinePos = await getCursor();
  while (startLinePos > 0 && text[startLinePos] !== "\n") {
    startLinePos--;
  }
  let endLinePos = startLinePos + 1;
  while (endLinePos < text.length && text[endLinePos] !== "\n") {
    endLinePos++;
  }
  const currentLine = text.substring(startLinePos, endLinePos);
  const match = /(https:\/\/.+)\/pl\/(\w{10,})/.exec(currentLine);
  if (match) {
    const [_fullMatch, serverUrl, postId] = match;

    const rootServerUrl = serverUrl.split("/").slice(0, 3).join("/");
    for (
      const [serverName, serverConfig] of Object.entries(mattermostServers)
    ) {
      if (serverConfig.url === rootServerUrl) {
        await flashNotification("Unsaving post...");
        await invokeFunction("server", "unsavePost", serverName, postId);
        await invokeCommand("Materialized Queries: Update");
        return;
      }
    }
    await flashNotification("Could not find server for post", "error");
  } else {
    await flashNotification("Could not find post in current line", "error");
  }
}

export async function unsavePost(serverName: string, postId: string) {
  const { client } = await getMattermostClientForServer(serverName);
  const me = await client.getMe();

  console.log("Unsaving", me.id, postId);
  const result = await client.deletePreferences(me.id, [
    {
      user_id: me.id,
      category: "flagged_post",
      name: postId,
    },
  ]);
  console.log("Done unsaving", result);
}

async function getMattermostClientForServer(serverName: string): Promise<{
  client: Client4;
  config: ServerConfig;
}> {
  // Fetch server configs
  const allSettings = (await readYamlPage("SETTINGS", ["yaml"])) || {};
  if (!allSettings.mattermost) {
    throw new Error(`No mattermost settings found`);
  }
  const mattermostServers: MattermostSettings = allSettings.mattermost;

  // Fetch auth tokens
  const [mattermostSecrets]: ServerSecrets[] = await readSecrets([
    "mattermost",
  ]);
  if (!mattermostSecrets) {
    throw new Error(`No mattermost SECRETS found`);
  }
  const serverConfig = mattermostServers[serverName];
  if (!serverConfig) {
    throw new Error(`Server ${serverName} not found in mattermost settings`);
  }

  // Instantiate client
  const client = new Client4();
  client.setUrl(serverConfig.url);
  client.setToken(mattermostSecrets[serverName]);
  return { client, config: serverConfig };
}

type ServerConfig = {
  url: string;
  defaultTeam?: string;
};
type MattermostSettings = {
  [serverName: string]: ServerConfig;
};

type ServerSecrets = {
  [serverName: string]: string;
};

export async function publishPostCommand() {
  const allSettings = (await readYamlPage("SETTINGS", ["yaml"])) || {};
  if (!allSettings.mattermost) {
    await flashNotification("No mattermost settings found", "error");
    return;
  }
  const [mattermostSecrets]: ServerSecrets[] = await readSecrets([
    "mattermost",
  ]);
  if (!mattermostSecrets) {
    await flashNotification("No mattermost secrets found", "error");
    return;
  }

  const servers: MattermostSettings = allSettings.mattermost;
  const selectedServer = await editor.filterBox(
    "Select server",
    Object.keys(servers).map((name) => ({ name })),
  );

  if (!selectedServer) {
    return;
  }

  const serverName = selectedServer.name;

  const allChannels: any[] = await system.invokeFunction(
    "server",
    "getAllChannels",
    serverName,
  );
  const selectedChannel = await editor.filterBox(
    "Select channel",
    allChannels.map((channel) => ({
      id: channel.id,
      name: channel.display_name,
    })),
    "Select the channel to publish to",
  );

  if (!selectedChannel) {
    return;
  }

  const { id: channelId } = (selectedChannel as any);

  // Prepare post text
  const text = await getText();
  const tree = await markdown.parseMarkdown(text);
  let { $share } = extractFrontmatter(tree, ["$share"]);
  if (!$share) {
    $share = [];
  }
  // Text without the frontmatter
  const cleanText = renderToText(tree);

  const post = await system.invokeFunction(
    "server",
    "createPost",
    serverName,
    channelId,
    cleanText,
  );

  const dispatchData = prepareFrontmatterDispatch(tree, {
    $share: [...$share, `mm-post:${serverName}:${post.id}`],
  });

  await editor.dispatch(dispatchData);
}

export async function getAllChannels(serverName: string) {
  const { client } = await getMattermostClientForServer(serverName);
  const cachingClient = new CachingClient4(client);

  return cachingClient.getAllMyChannels();
}

export async function createPost(
  serverName: string,
  channelId: string,
  message: string,
): Promise<any> {
  const { client } = await getMattermostClientForServer(serverName);
  return client.createPost({
    channel_id: channelId,
    message,
  });
}

export async function updatePost(
  event: PublishEvent,
) {
  const [_prefix, serverName, postId] = event.uri.split(":");

  const text = await space.readPage(event.name);
  const tree = await markdown.parseMarkdown(text);
  let { $share } = extractFrontmatter(tree, ["$share"]);
  if (!$share) {
    $share = [];
  }
  // Text without the frontmatter
  const message = renderToText(tree);
  const { client } = await getMattermostClientForServer(serverName);
  await client.updatePost({
    id: postId,
    message,
  });
  return true;
}

export async function checkCredentialsCommand() {
  const allSettings = (await readYamlPage("SETTINGS", ["yaml"])) || {};
  if (!allSettings.mattermost) {
    await flashNotification("No mattermost settings found", "error");
    return;
  }

  const servers: MattermostSettings = allSettings.mattermost;
  const selectedServer = await editor.filterBox(
    "Select server",
    Object.keys(servers).map((name) => ({ name })),
  );

  if (!selectedServer) {
    return;
  }

  try {
    const me = await system.invokeFunction(
      "server",
      "checkCredentials",
      selectedServer.name,
    );
    await editor.flashNotification(`Authenticated as ${me.username}`);
  } catch (e: any) {
    await editor.flashNotification(
      `Failed to authenticate: ${e.message}`,
      "error",
    );
  }
}

// Server side
export async function checkCredentials(
  serverName: string,
): Promise<any> {
  const { client } = await getMattermostClientForServer(serverName);
  return client.getMe();
}

import {
  extractFrontmatter,
  prepareFrontmatterDispatch,
} from "$sb/lib/frontmatter.ts";
import { renderToText } from "$sb/lib/tree.ts";
import { getText } from "$sb/silverbullet-syscall/editor.ts";
import {
  editor,
  markdown,
  space,
  system,
} from "$sb/silverbullet-syscall/mod.ts";
import { invokeFunction } from "$sb/silverbullet-syscall/system.ts";

import { CachingClient4 } from "./mattermost_client.ts";
import {
  extractPostUrl,
  getMattermostClientForServer,
  getServerConfigForUrl,
  loadMattermostConfig,
} from "./util.ts";

import type { PublishEvent } from "$sb/app_event.ts";
export async function publishPostCommand() {
  const { mattermostServers } = await loadMattermostConfig();

  const selectedServer = await editor.filterBox(
    "Select server",
    Object.keys(mattermostServers).map((name) => ({ name })),
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
  const { mattermostServers } = await loadMattermostConfig();
  const selectedServer = await editor.filterBox(
    "Select server",
    Object.keys(mattermostServers).map((name) => ({ name })),
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

export async function loadPostCommand() {
  // get post id from permalink, it should be a post id or a permalink
  const postUrl = await editor.prompt(
    "Mattermost post URL:",
  );
  if (!postUrl) {
    return; // user cancelled
  }

  try {
    const { postId, serverUrl } = extractPostUrl(postUrl);

    const { name: serverName } = await getServerConfigForUrl(serverUrl);
    const pageName = await editor.prompt(
      "Page to store the post:",
    );

    if (!pageName) {
      return;
    }

    await invokeFunction(
      "server",
      "postToPage",
      serverName,
      postId,
      pageName,
    );

    await editor.navigate(pageName);
  } catch (e: any) {
    await editor.flashNotification(
      `Error: ${e.message}`,
      "error",
    );
    return;
  }
}

// Returns whether the authenticated user is the author of the post
export async function postToPage(
  serverName: string,
  postId: string,
  pageName: string,
) {
  const { client } = await getMattermostClientForServer(serverName);
  const post = await client.getPost(postId);
  const me = await client.getMe();
  let text = post.message;

  if (me.id === post.user_id) {
    // Authenticated user is the author, we can do more!
    text = `---\n$share:\n- 'mm-post:${serverName}:${postId}'\n---\n${text}`;
  }
  await space.writePage(pageName, text);
}

export async function unfurl(permalink: string) {
  const { serverUrl, postId } = extractPostUrl(permalink);
  const { name: serverName } = await getServerConfigForUrl(serverUrl);
  const { client } = await getMattermostClientForServer(serverName);
  const post = await client.getPost(postId);
  const user = await client.getUser(post.user_id);
  const channel = await client.getChannel(post.channel_id);
  return `[${user.username}@${channel.display_name}](${permalink}):\n> ${
    post.message.split("\n").join("\n> ")
  }`;
}

export async function unfurlOptions(url: string) {
  try {
    // Try a lookup
    const { serverUrl } = extractPostUrl(url);
    await getServerConfigForUrl(serverUrl);
    // Apparently successful, good enough!
    return [{ id: "mattermost-unfurl", name: "Mattermost permalink content" }];
  } catch {
    return [];
  }
}

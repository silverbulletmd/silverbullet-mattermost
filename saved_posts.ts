import { niceDate } from "$sb/lib/dates.ts";
import { QueryProviderEvent } from "$sb/app_event.ts";
import {
  extractPostUrl,
  getMattermostClientForServer,
  getServerConfigForUrl,
  mattermostUrlForPost,
} from "./util.ts";
import { CachingClient4 } from "./mattermost_client.ts";
import { applyQuery } from "../silverbullet/plug-api/lib/query.ts";
import { editor, system } from "$sb/silverbullet-syscall/mod.ts";

type AugmentedPost = {
  // Dates we can use to filter
  createdAt: string;
  updatedAt: string;
  editedAt: string;
} & any;

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
  const text = await editor.getText();
  let startLinePos = await editor.getCursor();
  while (startLinePos > 0 && text[startLinePos] !== "\n") {
    startLinePos--;
  }
  let endLinePos = startLinePos + 1;
  while (endLinePos < text.length && text[endLinePos] !== "\n") {
    endLinePos++;
  }
  const currentLine = text.substring(startLinePos, endLinePos);
  try {
    console.log("Unsaving post", currentLine);
    const { serverUrl, postId } = extractPostUrl(currentLine);
    const { name: serverName } = await getServerConfigForUrl(serverUrl);
    await editor.flashNotification("Unsaving post...");
    await system.invokeFunction("server", "unsavePost", serverName, postId);
    await system.invokeCommand("Directives: Update");
    return;
  } catch (e: any) {
    console.error(e.message);
    await editor.flashNotification("Could not find server for post", "error");
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

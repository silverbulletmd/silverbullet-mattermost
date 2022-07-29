import { Client4 } from "@mattermost/client";
import {
  applyQuery,
  QueryProviderEvent,
} from "@silverbulletmd/plugs/query/engine";
import { niceDate } from "@silverbulletmd/plugs/core/dates";
import { Post } from "@mattermost/types/lib/posts";
import { CachingClient4 } from "./mattermost_client";
import { readSettings } from "@silverbulletmd/plugs/lib/settings_page";
import { readSecrets } from "@silverbulletmd/plugs/lib/secrets_page";
import { flashNotification } from "@silverbulletmd/plugos-silverbullet-syscall/editor";
import {
  invokeCommand,
  invokeFunction,
} from "@silverbulletmd/plugos-silverbullet-syscall/system";
import {
  getCursor,
  getText,
} from "@silverbulletmd/plugos-silverbullet-syscall/editor";

type AugmentedPost = Post & {
  // Dates we can use to filter
  createdAt: string;
  updatedAt: string;
  editedAt: string;
};

// https://community.mattermost.com/private-core/pl/rbp7a7jtr3f89nzsefo6ftqt3o

function mattermostUrlForPost(
  url: string,
  teamName: string,
  postId: string,
  desktop = false
) {
  return `${
    // For a desktop URL let's replace `https://` with `mattermost://`
    desktop ? url.replace("https://", "mattermost://") : url
  }/${teamName}/pl/${postId}`;
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
  let { client, config } = await getMattermostClient();
  let cachingClient = new CachingClient4(client);
  let me = await client.getMe();
  let postCollection = await client.getFlaggedPosts(me.id);

  let savedPosts: AugmentedPost[] = [];
  for (let order of postCollection.order) {
    let post = postCollection.posts[order];
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
      let channel = await cachingClient.getChannelCached(savedPost.channel_id);
      let teamName = config.mattermostDefaultTeam;
      if (channel.team_id) {
        let team = await cachingClient.getTeamCached(channel.team_id);
        teamName = team.name;
      }
      resultSavedPosts.push({
        ...savedPost,
        username: (await cachingClient.getUserCached(savedPost.user_id))
          .username,
        channelName: channel.display_name,
        teamName: teamName,
        url: mattermostUrlForPost(client.url, teamName, savedPost.id, false),
        desktopUrl: mattermostUrlForPost(
          client.url,
          teamName,
          savedPost.id,
          true
        ),
      });
    })
  );
  resultSavedPosts = applyQuery(query, resultSavedPosts);
  return resultSavedPosts;
}

export async function unsavePostCommand() {
  let text = await getText();
  let startLinePos = await getCursor();
  while (startLinePos > 0 && text[startLinePos] !== "\n") {
    startLinePos--;
  }
  let endLinePos = startLinePos + 1;
  while (endLinePos < text.length && text[endLinePos] !== "\n") {
    endLinePos++;
  }
  const currentLine = text.substring(startLinePos, endLinePos);
  let match = /\/pl\/(\w{10,})/.exec(currentLine);
  if (match) {
    const postId = match[1];

    await flashNotification("Unsaving post...");
    await invokeFunction("server", "unsavePost", postId);
    await invokeCommand("Materialized Queries: Update");
  } else {
    await flashNotification("Could not find post in current line", "error");
  }
}

export async function unsavePost(postId: string) {
  let { client } = await getMattermostClient();
  let me = await client.getMe();

  console.log("Unsaving", me.id, postId);
  let result = await client.deletePreferences(me.id, [
    {
      user_id: me.id,
      category: "flagged_post",
      name: postId,
    },
  ]);
  console.log("Done unsaving", result);
}

async function getMattermostClient(): Promise<{
  client: Client4;
  config: { mattermostUrl: string; mattermostDefaultTeam: string };
}> {
  let config = await readSettings({
    mattermostUrl: "https://community.mattermost.com",
    mattermostDefaultTeam: "core",
  });
  let [token] = await readSecrets(["mattermostToken"]);
  let client = new Client4();
  client.setUrl(config.mattermostUrl);
  client.setToken(token);
  return { client, config };
}

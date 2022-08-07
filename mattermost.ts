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
import { 
  flashNotification,
  prompt,
  getCursor,
  getText,
  navigate,
} from "@silverbulletmd/plugos-silverbullet-syscall/editor";
import {
  invokeCommand,
  invokeFunction,
} from "@silverbulletmd/plugos-silverbullet-syscall/system";
import { readPage, writePage} from "@silverbulletmd/plugos-silverbullet-syscall/space";
import { PageMeta } from "@silverbulletmd/common/types";

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

export async function post2Note(postID: string, noteName: string) {
    // does note already exist?
    let prevContent;
    let noteExists = true;
    try {
      prevContent = await readPage(noteName);
      noteExists = !!prevContent.text.length; //if it is empty is the same as unexistant
    } catch {
      noteExists = false;
    }

   // get post data
   const {client, config} = await getMattermostClient();
   let postContent;
   try {
     console.log(`requesting post ${postID}`);
     postContent = await client.getPost(postID);
   } catch (e) {
     console.log(`Unable to retrieve post contents: ${e.message}`);
     console.log(e);
     throw new Error("Couldn't retrieve post contents");
   }
   // write note
   const finalNote = noteExists ? `${prevContent!.text}\n${postContent.message}` : postContent.message;
   await writePage(noteName, finalNote);
   // navigate to note
   const pos = noteExists ? prevContent?.text.length : 0;
   return pos;
}

export async function post2NoteCommand() {
  // get post id from permalink, it should be a post id or a permalink
  const messageLink = await prompt("Go to your mattermost instance and copy the message link, paste it here:");
  if (!messageLink?.trim().length) {
    return await flashNotification("Link can't be blank!", "error");
  }
  const split = messageLink.split("pl/");
  const postID = split.length > 1 ? split[1] : split[0]; //not very fancy, but will do for most situations
  // get note name
  const noteName = await prompt("Where should I store this message?", "Mattermost Note");
  if (!noteName?.trim().length) {
    return await flashNotification("Name can't be blank", "error");
  }

  const pos = await invokeFunction('server', "post2Note", postID, noteName);
  return await navigate(noteName, pos);
}
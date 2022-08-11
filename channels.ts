import { Client4 } from "@mattermost/client";
import escapeStringRegexp from "escape-string-regexp";
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
  getCurrentPage,
} from "@silverbulletmd/plugos-silverbullet-syscall/editor";
import {
  invokeCommand,
  invokeFunction,
} from "@silverbulletmd/plugos-silverbullet-syscall/system";
import { readPage, writePage} from "@silverbulletmd/plugos-silverbullet-syscall/space";

type AugmentedPost = Post & {
  // Dates we can use to filter
  createdAt: string;
  updatedAt: string;
  editedAt: string;
};

const INSERT_AT_END = -1;

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

async function getFormattedPostContent(postID: string) {
  // get post data
  const {client, config} = await getMattermostClient();
  let postContent;
  try {
    postContent = await client.getPost(postID);
  } catch (e) {
    console.log(`Unable to retrieve post contents: ${e.message}`);
    throw new Error("Couldn't retrieve post contents");
  }
  try {
    const user = await client.getUser(postContent.user_id);
    const channel = await client.getChannel(postContent.channel_id);
    const team = await client.getTeam(channel.team_id);
    return `[${user.username}@${channel.display_name}](${config.mattermostUrl}/${team.name}/pl/${postID}):\n${postContent.message}`;
  } catch (e) {
    throw new Error("Unable to get metadata for post");
  }
}

export async function post2Note(postID: string, noteName: string, insertAt: number) {
    // does note already exist?
    let prevContent;
    let noteExists = true;
    try {
      prevContent = await readPage(noteName);
      noteExists = !!prevContent.text.length; //if it is empty is the same as unexistant
    } catch {
      noteExists = false;
    }

   const postContent = await getFormattedPostContent(postID);
   // write note
   let finalNote: string;
   if (!noteExists) {
    finalNote = postContent;
   } else if (insertAt !== INSERT_AT_END) {
    finalNote = `${prevContent.text.slice(0,insertAt)}${postContent}${prevContent.text.slice(insertAt)}`;
   } else {
    finalNote = `${prevContent!.text}\n${postContent}`;
   }
   await writePage(noteName, finalNote);
   // navigate to note
   const pos = noteExists ? prevContent?.text.length : 0;
   return pos;
}

function getPostID(permalink: string):string {
  // since we accept permalink urls, we try to split the post ID
  // usually it is like "https://server/team/pl/postID
  // if there is no `pl/` we'll try to assume it is a postID
  const split = permalink.split("pl/");
  return split.length > 1 ? split[1] : split[0]; //not very fancy, but will do for most situations
}

export async function post2NoteCommand() {
  // get post id from permalink, it should be a post id or a permalink
  const messageLink = await prompt("Go to your mattermost instance and copy the message link, paste it here:");
  if (typeof messageLink === 'undefined') {
    return; //user cancelled
  } else if (!messageLink?.trim().length) {
    return await flashNotification("Link can't be blank!", "error");
  }
 const postID = getPostID(messageLink);
  if (postID.length != 26) {
    return await flashNotification("Message link doesn't seem to contain a valid post id");
  }
  const currentPage = await getCurrentPage();
  // get note name
  const noteName = await prompt("Where should I store this message?", currentPage);
  if (typeof noteName === 'undefined') {
    return; //user cancelled
  } else if (!noteName?.trim().length) {
    return await flashNotification("Name can't be blank", "error");
  }
  const insertAt = noteName === currentPage ? await getCursor() : INSERT_AT_END;
  const pos = await invokeFunction('server', "post2Note", postID, noteName, insertAt);
  return await navigate(noteName, pos);
}

export async function unfurl(permalink: string) {
  const postID = getPostID(permalink);
  if (postID.length != 26) {
    throw new Error("Link doesn't seem to contain a valid post id");
  }
  return await getFormattedPostContent(postID);
}

export async function unfurlOptions(url: string) {
  let config = await readSettings({
    mattermostUrl: "https://community.mattermost.com",
  });
  const safeMattermostUrl = escapeStringRegexp(config.mattermostUrl);
  const regex = new RegExp(`${safeMattermostUrl}\/[^\/]+\/pl\/[^\/]+`);
  if (regex.exec(url)) {
    return [{ id: "mattermost-unfurl", name: "Permalink content" }];
  } else {
   console.log(`couldn't match against: ${regex.source}`);
   return [];
  }
}
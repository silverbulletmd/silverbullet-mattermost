# Mattermost plug for Silver Bullet
This plug provides a few query providers to query data from some of the [Mattermost suite](https://www.mattermost.com) of products. Please follow the installation, configuration sections, and have a look at the example.

Note: Boards integration is still WIP.

## Installation
Open your `PLUGS` note in SilverBullet and add this plug to the list:

```
- github:silverbulletmd/silverbullet-mattermost/mattermost.plug.json
```

Then run the `Plugs: Update` command and off you go!

## Configuration
In `SETTINGS` provide the `mattermost` key with a `url` and `defaultTeam` for each server (you can name them arbitrarily):

    ```yaml
    mattermost:
      community:
        url: https://community.mattermost.com
        defaultTeam: core
      silverbullet:
        url: https://silverbullet.cloud.mattermost.com
        defaultTeam: main
    ```

In `SECRETS` provide a Mattermost personal access token (or hijack one from your current session) for each server:

    ```yaml
    mattermost:
      community: 1234
      silverbullet: 1234
    ```


To make the `mm-saved` query results look good, it's recommended you render your query results a template. Here is one to start with, you can keep it in e.g. `templates/mm-saved`:

    [{{username}}]({{desktopUrl}}) in **{{channelName}}** at {{updatedAt}} {[Unsave]}:

    {{prefixLines (substring message 0 300 " ... (More)") "> "}}

    ---

Note that the `{[Unsaved]}` "button" when clicked, will unsave the post automatically 😎

## Query sources

* `mm-saved` fetches (by default 15) saved posts in Mattermost

## Posting to a channel

You can use the {[Share: Mattermost: Post]} command to publish the current page to a channel. You will be prompted to select the server and channel to post to. A `$share` key will be injected into frontmatter after the initial post. Subsequent post edits can be published via the standard {[Share: Publish]} command.

## Example

Example use of `mm-saved` (using the `template/mm-saved` template above):

    <!-- #query mm-saved where server = "community" order by updatedAt desc limit 5 render "template/mm-saved" -->

    <!-- /query -->


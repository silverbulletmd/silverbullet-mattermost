import {
  applyQuery,
  QueryProviderEvent,
} from "@silverbulletmd/plugs/query/engine";

async function fetchCardsFromSharedBoard(url: string): Promise<any[]> {
  let parsedUrl = new URL(url);
  let readToken = parsedUrl.searchParams.get("r");
  let matterMostUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
  // Extract the workspace and blockId from the URL
  let [, , , , workspaceId, , blockId] = parsedUrl.pathname.split("/");

  let result = await fetch(
    `${matterMostUrl}/plugins/focalboard/api/v1/workspaces/${workspaceId}/blocks/${blockId}/subtree?l=3&read_token=${readToken}`,
    {
      headers: {
        // Without this, I get a CSRF error
        "x-requested-with": "XMLHttpRequest",
      },
    }
  );
  let allBlocks = await result.json();
  let blockMap = new Map<string, any>();
  let cardProperties = new Map<string, any>();
  for (let block of allBlocks) {
    if (block.type === "board") {
      cardProperties = new Map(
        block.fields.cardProperties.map((prop) => [prop.id, prop])
      );
      console.log("Card properties:", cardProperties);
    }
    blockMap.set(block.id, block);
  }
  let allCards: any[] = [];
  for (let block of blockMap.values()) {
    if (block.type === "card") {
      let card = {
        id: block.id,
        title: block.title,
      };
      for (let [key, value] of Object.entries(block.fields.properties)) {
        let propLookup = cardProperties.get(key);
        if (propLookup) {
          let valueOption = propLookup.options.find(
            (option) => option.id === value
          );
          let propName = propLookup.name
            .toLowerCase()
            .replaceAll(/\W/g, "")
            .trim()
            .replaceAll(/\s/g, "_");
          if (valueOption) {
            card[propName] = valueOption.value;
          } else {
            card[propName] = value;
          }
        }
      }
      allCards.push(card);
    }
  }
  return allCards;
}

export async function boardsQueryProvider({
  query,
}: QueryProviderEvent): Promise<any[]> {
  let urlFilter = query.filter.find((f) => f.prop === "url");
  if (!urlFilter) {
    throw Error("No 'url' filter specified, this is mandatory");
  }
  query.filter.splice(query.filter.indexOf(urlFilter), 1);
  let cards = await fetchCardsFromSharedBoard(urlFilter.value);
  cards = applyQuery(query, cards);
  return cards;
}

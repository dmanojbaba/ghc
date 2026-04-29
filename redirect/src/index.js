export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      return await handlePostRequest(request, env).catch(
        (err) => new Response(err.stack, { status: 500 })
      );
    } else {
      return await handleGetRequest(request, env).catch(
        (err) => new Response(err.stack, { status: 500 })
      );
    }
  },
  async scheduled(event, env, ctx) {
    switch (event.cron) {
      // update kv for pttv and sun news
      case "0 6-22 * * *": {
        const isVideoUrl = (url) => url.startsWith("https://www.youtube.com/watch?v=");

        const pttvId = await searchYoutube(
          env,
          "Puthiyathalaimurai Headlines",
          false,
          "&maxResults=50&order=date&channelId=UCmyKnNRH0wH-r8I-ceP-dsg",
          "Today Headlines"
        );
        if (isVideoUrl(pttvId)) {
          await env.kv.put("pttv", pttvId);
        } else {
          console.error("pttv: searchYoutube returned no video", pttvId);
        }

        const sunId = await searchYoutube(
          env,
          "Sun News Headlines Now",
          false,
          "&maxResults=50&order=date&channelId=UCYlh4lH762HvHt6mmiecyWQ",
          "Headlines Now"
        );
        if (isVideoUrl(sunId)) {
          await env.kv.put("sun", sunId);
        } else {
          console.error("sun: searchYoutube returned no video", sunId);
        }

        break;
      }

      // example second cron
      case "3 3 * * *":
        break;
    }
  },
};

async function listKvKeys(kv) {
  const { keys } = await kv.list();
  return keys.filter((k) => k.name !== "status").map((k) => k.name).join(" ");
}

async function handleGetRequest(request, env) {
  const url = new URL(request.url);
  const urlParts = url.pathname.split("/");
  const searchParams = url.searchParams;

  // return client ip
  if (urlParts[1] === "ip") {
    return new Response(request.headers.get("CF-Connecting-IP"));
  // return the value from kv store
  } else if (urlParts[1] === "kv") {
    const kv_key = urlParts[2];
    if (!kv_key) {
      if (searchParams.get("output") === "json") {
        const { keys } = await env.kv.list();
        return new Response(JSON.stringify(keys, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(await listKvKeys(env.kv));
    }
    const kv_value = await env.kv.get(kv_key.toLowerCase()) ?? "null";
    if (searchParams.get("output") === "json") {
      return new Response(JSON.stringify({ key: kv_key, value: kv_value }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(kv_value);
  // redirect to value from kv store or youtube search
  } else if (urlParts[1] === "r") {
    const kv_key = urlParts[2];
    if (!kv_key) return new Response("null");
    const kv_value = await env.kv.get(kv_key.toLowerCase());
    if (kv_value !== null) {
      return Response.redirect(kv_value, 302);
    }
    const videoUrl = await searchYoutube(env, decodeURIComponent(urlParts[2]));
    return Response.redirect(videoUrl, 302);
  // return file from r2 bucket
  } else if (urlParts[1] === "r2") {
    const kv_key = urlParts[2];
    if (!kv_key) return new Response("null");
    const object = await env.r2bkt.get(kv_key.toLowerCase());
    if (object !== null) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }
    return new Response("null");
  // return raw youtube search result
  } else if (urlParts[1] === "y") {
    const kv_key = urlParts[2];
    if (!kv_key) return new Response("null");
    const extraParams = searchParams.toString() ? "&" + searchParams.toString() : "";
    const returnString = await searchYoutube(
      env,
      decodeURIComponent(kv_key),
      true,
      extraParams
    );
    return new Response(returnString, {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("not found", { status: 404 });
}

async function handlePostRequest(request, env) {
  const urlParts = new URL(request.url).pathname.split("/");

  // return the posted data
  if (urlParts[1] === "_raw") {
    return new Response(await request.text());
  // return the value from kv store
  } else if (urlParts[1] === "kv") {
    const body = await request.json().catch(() => null);
    const kv_key = body?.text;
    if (!kv_key) {
      return new Response(await listKvKeys(env.kv));
    }
    const kv_value = await env.kv.get(kv_key.toLowerCase()) ?? "null";
    return new Response(kv_value);
  }

  return new Response("not found", { status: 404 });
}

async function searchYoutube(
  env,
  searchText,
  raw = false,
  extraParams = "",
  altMatchText = ""
) {
  const isSingleWord = !searchText.trim().includes(" ");

  if (isSingleWord) {
    const requestByID = `https://www.googleapis.com/youtube/v3/videos?part=snippet&key=${
      env.YOUTUBE_API_KEY
    }&id=${encodeURIComponent(searchText)}${extraParams}`;
    const dataByID = await fetch(requestByID).then((r) => r.json());

    if (dataByID.error === undefined && dataByID.items.length > 0) {
      const videoId = dataByID.items[0].id;
      const videoTitle = dataByID.items[0].snippet.title;
      return raw
        ? JSON.stringify(
            {
              result: dataByID.items.length,
              videoUrl: "https://www.youtube.com/watch?v=" + videoId,
              videoTitle: videoTitle,
            },
            null,
            2
          )
        : "https://www.youtube.com/watch?v=" + videoId;
    }
    // not a valid video ID — fall through to search API below
  }

  const requestUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&key=${
    env.YOUTUBE_API_KEY
  }&q=${encodeURIComponent(searchText)}${extraParams}`;
  const data = await fetch(requestUrl).then((r) => r.json());

  if (data.error !== undefined || data.items.length == 0) {
    return raw ? JSON.stringify(data, null, 2) : "https://www.youtube.com";
  }

  let count = 0;
  let videoId = "";
  let videoTitle = "";

  for (const item of data.items) {
    count = count + 1;
    if (
      item.snippet.title.toUpperCase().match(searchText.toUpperCase()) ||
      (altMatchText != undefined &&
        item.snippet.title.toUpperCase().startsWith(altMatchText.toUpperCase()))
    ) {
      videoId = item.id.videoId;
      videoTitle = item.snippet.title;
      break;
    }
  }

  const noMatch = videoId === "";
  if (noMatch) {
    videoId = data.items[0].id.videoId;
    videoTitle = data.items[0].snippet.title;
  }

  return raw
    ? JSON.stringify(
        {
          result: (noMatch ? 0 : count) + "/" + data.items.length,
          videoUrl: "https://www.youtube.com/watch?v=" + videoId,
          videoTitle: videoTitle,
        },
        null,
        2
      )
    : "https://www.youtube.com/watch?v=" + videoId;
}

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
      case "0 6-22 * * *":
        const pttvId = await searchYoutube(
          env,
          "Puthiyathalaimurai Headlines",
          false,
          "&maxResults=50&order=date&channelId=UCmyKnNRH0wH-r8I-ceP-dsg",
          "Today Headlines"
        );
        await env.kv.put("pttv", pttvId);

        const sunId = await searchYoutube(
          env,
          "Sun News Headlines Now",
          false,
          "&maxResults=50&order=date&channelId=UCYlh4lH762HvHt6mmiecyWQ",
          "Headlines Now"
        );
        await env.kv.put("sun", sunId);

        break;

      // example second cron
      case "3 3 * * *":
        break;
    }
  },
};

function parseQueryString(queryString) {
  return Object.fromEntries(
    queryString.split("&").map((kvp) => {
      const [key, value] = kvp.split("=").map(decodeURIComponent);
      return [key, value];
    })
  );
}

async function handleGetRequest(request, env) {
  const [path, queryString] = request.url.split("?");
  const urlParts = path.split("/");
  const queryParts = queryString ? parseQueryString(queryString) : {};

  // return client ip
  if (urlParts[3] === "ip") {
    return new Response(request.headers.get("CF-Connecting-IP"));
  }
  // return the value from kv store
  else if (urlParts[3] === "kv") {
    const kv_key = urlParts[4];
    if (kv_key === undefined || kv_key == "") {
      const kv_all = await env.kv.list();
      if (queryParts["output"] == "json") {
        return new Response(JSON.stringify(kv_all.keys, null, 2), {
          headers: {
            "Content-Type": "application/json",
          },
        });
      } else {
        const kv_array = [];
        for (var k in kv_all.keys) {
          if (kv_all.keys[k]["name"] !== "status") {
            kv_array.push(kv_all.keys[k]["name"]);
          }
        }
        return new Response(kv_array.join(" "));
      }
    }
    let kv_value = await env.kv.get(kv_key.toLowerCase());
    if (kv_value === null) {
      kv_value = "null";
    }
    if (queryParts["output"] == "json") {
      return new Response(
        JSON.stringify({ key: kv_key, value: kv_value }, null, 2),
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    } else {
      return new Response(kv_value);
    }
  }
  // redirect to value from kv store or youtube search
  else if (urlParts[3] === "r") {
    const kv_key = urlParts[4];
    if (kv_key === undefined || kv_key == "") {
      return new Response("null");
    }
    const kv_value = await env.kv.get(kv_key.toLowerCase());
    if (kv_value !== null) {
      return Response.redirect(kv_value, 301);
    } else {
      const videoUrl = await searchYoutube(
        env,
        decodeURIComponent(urlParts[4])
      );
      return Response.redirect(videoUrl, 301);
    }
  }
  // return file from r2 bucket
  else if (urlParts[3] === "r2") {
    const kv_key = urlParts[4];
    if (kv_key === undefined || kv_key == "") {
      return new Response("null");
    }
    const object = await env.r2bkt.get(kv_key.toLowerCase());
    if (object !== null) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    } else {
      return new Response("null");
    }
  }
  // return raw youtube search result
  else if (urlParts[3] === "y") {
    const kv_key = urlParts[4];
    if (kv_key === undefined || kv_key == "") {
      return new Response("null");
    }
    const returnString = await searchYoutube(
      env,
      decodeURIComponent(kv_key),
      true,
      "&" + queryString
    );
    return new Response(returnString, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return new Response("Hello World");
}

async function handlePostRequest(request, env) {
  const urlParts = request.url.split("?")[0].split("/");
  const queryString = request.url.split("?")[1];
  const reqBody = await readRequestBody(request);

  let queryParts = {};
  if (queryString != undefined) {
    queryParts = parseQueryString(queryString);
  }

  // return the posted data
  if (urlParts[3] === "_raw") {
    return new Response(reqBody);
  }
  // return the value from kv store
  else if (urlParts[3] === "kv") {
    let kv_key = "null";
    if (reqBody !== "null" && Object.keys(JSON.parse(reqBody)).length > 0) {
      kv_key = JSON.parse(reqBody).text;
    }
    if (kv_key == "" || kv_key == "null") {
      const kv_all = await env.kv.list();
      const kv_array = [];
      for (var k in kv_all.keys) {
        if (kv_all.keys[k]["name"] !== "status") {
          kv_array.push(kv_all.keys[k]["name"]);
        }
      }
      return new Response(kv_array.join(" "));
    }
    if (kv_key === undefined) {
      kv_key = Object.keys(JSON.parse(reqBody))[0];
    }
    let kv_value = await env.kv.get(kv_key.toLowerCase());
    if (kv_value === null) {
      kv_value = "null";
    }
    return new Response(kv_value);
  }

  return new Response("Hello World Again");
}

async function readRequestBody(request) {
  const contentType = request.headers.get("content-type");
  if (contentType === null) {
    return "null";
  } else if (contentType.includes("application/json")) {
    return JSON.stringify(await request.json());
  } else if (contentType.includes("application/text")) {
    return request.text();
  } else if (contentType.includes("text/html")) {
    return request.text();
  } else if (contentType.includes("form")) {
    const formData = await request.formData();
    const body = {};
    for (const entry of formData.entries()) {
      body[entry[0]] = entry[1];
    }
    return JSON.stringify(body);
  } else {
    return JSON.stringify({ text: "unknown" });
  }
}

async function searchYoutube(
  env,
  searchText,
  raw = false,
  extraParams = "",
  altMatchText = ""
) {
  let count = 0;
  let videoId = "";
  let videoTitle = "";
  let returnString = "";

  if (searchText.trim().includes(" ") == false && raw == false) {
    returnString = "https://www.youtube.com/watch?v=" + searchText.trim();
    return returnString;
  } else if (searchText.trim().includes(" ") == false) {
    let requestByID = `https://www.googleapis.com/youtube/v3/videos?part=snippet&key=${
      env.API_KEY
    }&id=${encodeURIComponent(searchText)}${extraParams}`;
    const responseByID = await fetch(requestByID);
    const dataByID = await responseByID.json();

    if (typeof dataByID.error !== "undefined" || data.items.length == 0) {
      if (raw == true) {
        return JSON.stringify(dataByID, null, 2);
      } else {
        return "https://www.youtube.com";
      }
    }

    if (dataByID.items.length > 0) {
      videoId = dataByID.items[0].id;
      videoTitle = dataByID.items[0].snippet.title;
      if (raw == true) {
        returnString = JSON.stringify(
          {
            result: dataByID.items.length,
            videoUrl: "https://www.youtube.com/watch?v=" + videoId,
            videoTitle: videoTitle,
          },
          null,
          2
        );
      } else {
        returnString = "https://www.youtube.com/watch?v=" + videoId;
      }
    }
  } else {
    let requestUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&key=${
      env.API_KEY
    }&q=${encodeURIComponent(searchText)}${extraParams}`;
    const response = await fetch(requestUrl);
    const data = await response.json();

    if (typeof data.error !== "undefined" || data.items.length == 0) {
      if (raw == true) {
        return JSON.stringify(data, null, 2);
      } else {
        return "https://www.youtube.com";
      }
    }

    for (const item in data.items) {
      count = count + 1;
      if (
        data.items[item].snippet.title
          .toUpperCase()
          .match(searchText.toUpperCase()) ||
        (altMatchText != undefined &&
          data.items[item].snippet.title
            .toUpperCase()
            .startsWith(altMatchText.toUpperCase()))
      ) {
        videoId = data.items[item].id.videoId;
        videoTitle = data.items[item].snippet.title;
        break;
      }
    }
    if (count == data.items.length && data.items.length > 0) {
      count = 1;
      videoId = data.items[0].id.videoId;
      videoTitle = data.items[0].snippet.title;
    }
    if (raw == true) {
      returnString = JSON.stringify(
        {
          result: count + "/" + data.items.length,
          videoUrl: "https://www.youtube.com/watch?v=" + videoId,
          videoTitle: videoTitle,
        },
        null,
        2
      );
    } else {
      returnString = "https://www.youtube.com/watch?v=" + videoId;
    }
  }
  return returnString;
}

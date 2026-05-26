# SPDX-License-Identifier: AGPL-3.0-only
import json, asyncdispatch, strutils, times

import jester

import ".."/routes/router_utils
import ".."/[types, redis_cache]
import list

proc formatBroadcastAsJson*(bc: Broadcast): JsonNode =
  proc dateToUnix(dt: DateTime): int64 =
    if dt.year > 1: dt.toTime.toUnix() else: 0

  return %*{
    "id": bc.id,
    "title": bc.title,
    "state": bc.state,
    "thumb": bc.thumb,
    "mediaKey": bc.mediaKey,
    "m3u8Url": bc.m3u8Url,
    "totalWatched": bc.totalWatched,
    "startTime": dateToUnix(bc.startTime),
    "endTime": dateToUnix(bc.endTime),
    "replayStart": bc.replayStart,
    "availableForReplay": bc.availableForReplay,
    "user": formatUserAsJson(bc.user)
  }

proc createJsonApiBroadcastRouter*(cfg: Config) =
  router jsonapi_broadcast:
    get "/api/i/broadcasts/@id":
      cond @"id".allCharsInSet({'a'..'z', 'A'..'Z', '0'..'9'})
      var bc: Broadcast
      try:
        bc = await getCachedBroadcast(@"id")
      except:
        discard

      if bc.id.len == 0:
        respJsonError("Broadcast not found", "not_found", Http404)

      respJsonSuccess formatBroadcastAsJson(bc)

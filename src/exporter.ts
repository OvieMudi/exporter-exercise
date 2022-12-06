import { Writable, Stream } from "stream";
import { RedisClient } from "redis";
import { PermissionsService, User } from "./permissions";
import util from "util";
import { UUID } from "./uuid";
import { Logger } from "./logger";
import { ReadStream } from "fs";

interface Exporter {
  StartExport: (user: User, data: Stream) => Promise<ExportStatus>;
  GetExportStatus: (id: string) => Promise<ExportStatus>;
  CancelExport: (
    user: User,
    exportId: string,
    data: ReadStream
  ) => Promise<ExportStatus>;
}

type ExportStatus = {
  status: string;
  id: string;
};

export type HBExporterDependencies = {
  cache: RedisClient;
  permissionsService: PermissionsService;
  allowedPermission: string;
  UUIDGen: UUID;
  logger: Logger;
};

export const HBExporter = (deps: HBExporterDependencies): Exporter => {
  const get = util.promisify(deps.cache.GET).bind(deps.cache);
  const set = util.promisify(deps.cache.SET).bind(deps.cache);
  const expire = util.promisify(deps.cache.EXPIRE).bind(deps.cache);

  return {
    StartExport: async (user, data) => {
      deps.logger("starting export");
      try {
        await checkUserPermissions(deps, user);
        const exportId = deps.UUIDGen.NewUUID();
        const newStatus = {
          status: "CREATED",
          id: exportId,
        };
        await set(exportId, JSON.stringify(newStatus));
        data.pipe(newCacheWriter(exportId, deps.cache));
        return newStatus;
      } catch (e) {
        console.log("error");
        throw e;
      }
    },

    GetExportStatus: async (exportId) => {
      const strStatus = await get(exportId);
      if (!strStatus) {
        throw new Error(`no export found for id: ${exportId}`);
      }
      const status: ExportStatus = JSON.parse(strStatus);
      return status;
    },

    async CancelExport(user, exportId, dataStream) {
      deps.logger("canceling export");
      try {
        await checkUserPermissions(deps, user);
        const strStatus = await this.GetExportStatus(exportId);
        if (strStatus.status === "COMPLETE") {
          throw new Error("Cannot cancel a completed export.");
        }

        const newStatus = { status: "CANCELLED", id: exportId };

        dataStream.destroy();
        dataStream.on("close", async () => {
          await set(exportId, JSON.stringify(newStatus));
          // we don't want to delete the status and data chunks immediately
          await expire(exportId, 60 * 60);
          await expire(exportId + "-data", 60 * 60);
        });

        return newStatus;
      } catch (e) {
        console.log("error", e);
        throw e;
      }
    },
  };
};

function newCacheWriter(exportId: string, cache: RedisClient) {
  const append = util.promisify(cache.APPEND).bind(cache);
  const set = util.promisify(cache.SET).bind(cache);
  const expire = util.promisify(cache.EXPIRE).bind(cache);

  return new Writable({
    // we want consume the read stream
    // and write to the cache
    async write(chunk, _, callback) {
      await append(exportId + "-data", chunk.toString("binary"));
      await set(exportId, JSON.stringify({ status: "PENDING", id: exportId }));
      callback();
    },
    async final(callback) {
      await set(exportId, JSON.stringify({ status: "COMPLETE", id: exportId }));
      await expire(exportId, 60 * 60);
      await expire(exportId + "-data", 60 * 60);
      callback();
    },
  });
}

// The checking of user permissions is abstracted here for code reuse
async function checkUserPermissions(deps: HBExporterDependencies, user: User) {
  const allowed = await deps.permissionsService.CheckPermissions(
    user,
    deps.allowedPermission
  );
  if (!allowed) {
    throw new Error("incorrect permission");
  }
}

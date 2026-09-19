import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAGINATION } from "../pagination.js";
import type { V3AuthContext } from "../router/auth.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { UserEntity } from "../types.js";
import { MetadataService } from "./metadata-service.js";

function ctx(userId: string, over: Partial<V3AuthContext> = {}): V3AuthContext {
  return { token: `key-${userId}`, userId, isAdmin: false, isSystemAdmin: false, ...over };
}

describe("MetadataService orphan agent lifecycle", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;
  let seq = 0;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    service = new MetadataService(store, "test-instance", undefined, {
      maxUsersPerInstance: 1000,
      maxTeamsPerInstance: 1000,
    });
  });

  afterEach(() => store.close());

  async function createUser(prefix: string): Promise<UserEntity> {
    seq += 1;
    return store.createUser({
      auth_provider: "local",
      external_id: `${prefix}-ext-${seq}`,
      username: `${prefix}-${seq}`,
    });
  }

  async function createTeam() {
    const owner = await createUser("owner");
    const team = store.createTeam({ name: `team-${seq}`, owner_user_id: owner.user_id });
    return { owner, team };
  }

  it("removes every agent in the target team without touching another team", async () => {
    const teamA = await createTeam();
    const teamB = await createTeam();
    const member = await createUser("member");
    store.addTeamMember({ team_id: teamA.team.team_id, user_id: member.user_id, role: "member" });
    store.addTeamMember({ team_id: teamB.team.team_id, user_id: member.user_id, role: "member" });

    for (let i = 0; i < DEFAULT_PAGINATION.limit + 5; i += 1) {
      store.createAgent({
        team_id: teamA.team.team_id,
        owner_user_id: member.user_id,
        name: `agent-a-${i}`,
      });
    }
    const otherAgent = store.createAgent({
      team_id: teamB.team.team_id,
      owner_user_id: member.user_id,
      name: "agent-b",
    });

    await service.removeTeamMemberForCaller(
      teamA.team.team_id,
      member.user_id,
      ctx(teamA.owner.user_id),
    );

    expect(store.getTeamMember(teamA.team.team_id, member.user_id)).toBeNull();
    expect(store.listAgentsByTeam(teamA.team.team_id, DEFAULT_PAGINATION).total).toBe(0);
    expect(store.getAgentById(otherAgent.agent_id)).not.toBeNull();
  });

  it("deletes a user's agents across teams and purges memory content first", async () => {
    const teamA = await createTeam();
    const teamB = await createTeam();
    const member = await createUser("member");
    const agents = [teamA, teamB].map(({ team }, index) => store.createAgent({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: `agent-${index}`,
    }));
    const cleaner = vi.fn(async () => {});
    service.setChatMemoryContentCleaner(cleaner);

    await service.deleteUsersForCaller(
      [member.user_id],
      ctx("system-admin", { isSystemAdmin: true }),
    );

    expect(store.getUserById(member.user_id)).toBeNull();
    expect(agents.every((agent) => store.getAgentById(agent.agent_id) === null)).toBe(true);
    expect(cleaner).toHaveBeenCalledTimes(2);
  });

  it("allows a team admin to delete a member agent", async () => {
    const { owner, team } = await createTeam();
    const member = await createUser("member");
    const agent = store.createAgent({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: "member-agent",
    });

    const result = await service.deleteAgentsForCaller([agent.agent_id], ctx(owner.user_id));

    expect(result.deleted_ids).toContain(agent.agent_id);
    expect(store.getAgentById(agent.agent_id)).toBeNull();
  });

  it("allows a system admin outside the team to archive an agent", async () => {
    const { team } = await createTeam();
    const member = await createUser("member");
    const agent = store.createAgent({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: "member-agent",
    });

    const archived = await service.archiveAgentForCaller(
      agent.agent_id,
      ctx("system-admin", { isSystemAdmin: true }),
    );

    expect(archived.status).toBe("inactive");
  });

  it("still rejects an unrelated user", async () => {
    const { team } = await createTeam();
    const member = await createUser("member");
    const agent = store.createAgent({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: "member-agent",
    });

    await expect(
      service.deleteAgentsForCaller([agent.agent_id], ctx("outsider")),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(store.getAgentById(agent.agent_id)).not.toBeNull();
  });
});

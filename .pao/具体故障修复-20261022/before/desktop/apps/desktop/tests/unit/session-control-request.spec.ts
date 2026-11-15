import { expect, test } from "@playwright/test";
import { expectSessionControlRequest } from "../../electron/ipc/request-validation";

/** 单一控制入口的请求校验（设计包 §3）：联合类型逐支白名单，未知字段拒绝。 */

const target = { workspaceId: "ws-a", sessionId: "session-a" };

test("session control accepts well-formed requests per action branch", () => {
  expect(
    expectSessionControlRequest({
      target,
      requestId: "req-1",
      action: { kind: "send", text: "hello" },
    }),
  ).toEqual({ target, requestId: "req-1", action: { kind: "send", text: "hello" } });

  expect(
    expectSessionControlRequest({
      target,
      requestId: "req-2",
      action: {
        kind: "send",
        text: "hello",
        deliverAs: "steer",
        attachments: [
          { id: "a1", kind: "image", name: "shot.png", mimeType: "image/png", data: "AAAA" },
        ],
      },
    }),
  ).toEqual({
    target,
    requestId: "req-2",
    action: {
      kind: "send",
      text: "hello",
      deliverAs: "steer",
      attachments: [
        { id: "a1", kind: "image", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ],
    },
  });

  expect(
    expectSessionControlRequest({ target, requestId: "req-3", action: { kind: "cancel" } }),
  ).toEqual({ target, requestId: "req-3", action: { kind: "cancel" } });

  expect(
    expectSessionControlRequest({
      target,
      requestId: "req-4",
      action: { kind: "dispatch", cardGoal: "登录页重构", dispatchReason: "P0 缺陷" },
    }),
  ).toEqual({
    target,
    requestId: "req-4",
    action: { kind: "dispatch", cardGoal: "登录页重构", dispatchReason: "P0 缺陷" },
  });

  expect(
    expectSessionControlRequest({
      target,
      requestId: "req-5",
      action: { kind: "confirm", cardRef: "card-1", basis: "验收口径全绿" },
    }),
  ).toEqual({
    target,
    requestId: "req-5",
    action: { kind: "confirm", cardRef: "card-1", basis: "验收口径全绿" },
  });

  expect(
    expectSessionControlRequest({
      target,
      requestId: "req-6",
      action: { kind: "query" },
    }),
  ).toEqual({ target, requestId: "req-6", action: { kind: "query" } });

  expect(
    expectSessionControlRequest({
      target,
      requestId: "req-7",
      action: { kind: "query", requestId: "req-1" },
    }),
  ).toEqual({ target, requestId: "req-7", action: { kind: "query", requestId: "req-1" } });
});

test("session control rejects unknown actions and malformed request ids", () => {
  expect(() =>
    expectSessionControlRequest({ target, requestId: "r", action: { kind: "reopen" } }),
  ).toThrow("action.kind must be send, cancel, dispatch, confirm, or query");
  expect(() =>
    expectSessionControlRequest({ target, requestId: "", action: { kind: "cancel" } }),
  ).toThrow("requestId must not be empty");
  expect(() =>
    expectSessionControlRequest({ target, requestId: "   ", action: { kind: "cancel" } }),
  ).toThrow("requestId must not be empty");
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r".repeat(129),
      action: { kind: "cancel" },
    }),
  ).toThrow("requestId must be at most 128 characters");
  expect(() =>
    expectSessionControlRequest({ target, action: { kind: "cancel" } }),
  ).toThrow("requestId must be a string");
  expect(() =>
    expectSessionControlRequest({ requestId: "r", action: { kind: "cancel" } }),
  ).toThrow();
});

test("session control rejects unknown fields at every level", () => {
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r",
      extra: 1,
      action: { kind: "cancel" },
    }),
  ).toThrow("session control request contains an unsupported field: extra");
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r",
      action: { kind: "send", text: "hi", foo: "bar" },
    }),
  ).toThrow("action contains an unsupported field: foo");
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r",
      action: { kind: "cancel", text: "nope" },
    }),
  ).toThrow("action contains an unsupported field: text");
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r",
      action: { kind: "query", text: "nope" },
    }),
  ).toThrow("action contains an unsupported field: text");
});

test("session control validates dispatch/confirm payload and send options", () => {
  expect(() =>
    expectSessionControlRequest({ target, requestId: "r", action: { kind: "dispatch" } }),
  ).toThrow("action.cardGoal must be a string");
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r",
      action: { kind: "dispatch", cardGoal: "  " },
    }),
  ).toThrow("action.cardGoal must not be empty");
  expect(
    expectSessionControlRequest({
      target,
      requestId: "r",
      action: { kind: "confirm", cardRef: "card-1" },
    }),
  ).toEqual({ target, requestId: "r", action: { kind: "confirm", cardRef: "card-1" } });
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r",
      action: { kind: "send", text: "hi", deliverAs: "immediate" },
    }),
  ).toThrow("options.deliverAs must be steer or followUp");
  expect(() =>
    expectSessionControlRequest({
      target,
      requestId: "r",
      action: {
        kind: "send",
        text: "hi",
        attachments: [{ id: "a", kind: "link", name: "x", mimeType: "text/uri-list" }],
      },
    }),
  ).toThrow("action.attachments[0].kind must be image or file");
});

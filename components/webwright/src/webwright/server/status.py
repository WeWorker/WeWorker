from __future__ import annotations

from enum import Enum


class TaskStatus(str, Enum):
    QUEUED = "queued"
    STARTING_BROWSER = "starting_browser"
    RUNNING = "running"
    WAITING_FOR_USER = "waiting_for_user"
    CANCEL_REQUESTED = "cancel_requested"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ReplayStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DevelopmentRunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DebugRunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AgentExitStatus(str, Enum):
    """Terminal statuses persisted in trajectory.json by DefaultAgent."""

    SUBMITTED = "Submitted"
    PAUSED = "Paused"
    CANCELLED = "Cancelled"
    LIMITS_EXCEEDED = "LimitsExceeded"
    FORMAT_ERROR = "FormatError"


class StepStatus(str, Enum):
    """Read-only statuses derived from persisted step artifacts."""

    UNKNOWN = "unknown"
    OK = "ok"
    ERROR = "error"
    DONE = "done"


TASK_STATUS_VALUES = tuple(status.value for status in TaskStatus)
REPLAY_STATUS_VALUES = tuple(status.value for status in ReplayStatus)
DEVELOPMENT_RUN_STATUS_VALUES = tuple(status.value for status in DevelopmentRunStatus)
DEBUG_RUN_STATUS_VALUES = tuple(status.value for status in DebugRunStatus)
AGENT_EXIT_STATUS_VALUES = tuple(status.value for status in AgentExitStatus)
STEP_STATUS_VALUES = tuple(status.value for status in StepStatus)

AGENT_EXIT_TO_TASK_STATUS = {
    AgentExitStatus.SUBMITTED: TaskStatus.SUCCEEDED.value,
    AgentExitStatus.PAUSED: TaskStatus.WAITING_FOR_USER.value,
    AgentExitStatus.CANCELLED: TaskStatus.CANCELLED.value,
    AgentExitStatus.LIMITS_EXCEEDED: TaskStatus.FAILED.value,
    AgentExitStatus.FORMAT_ERROR: TaskStatus.FAILED.value,
}
AGENT_EXIT_ERROR_MESSAGES = {
    AgentExitStatus.LIMITS_EXCEEDED: "Step limit exceeded.",
    AgentExitStatus.FORMAT_ERROR: "Model repeatedly failed to produce the required action JSON.",
}

TERMINAL_TASK_STATUSES = frozenset(
    {
        TaskStatus.SUCCEEDED.value,
        TaskStatus.FAILED.value,
        TaskStatus.CANCELLED.value,
    }
)
TERMINAL_REPLAY_STATUSES = frozenset(
    {
        ReplayStatus.SUCCEEDED.value,
        ReplayStatus.FAILED.value,
        ReplayStatus.CANCELLED.value,
    }
)

STOP_TASK_EVENT_STATUSES = TERMINAL_TASK_STATUSES | frozenset(
    {
        TaskStatus.WAITING_FOR_USER.value,
    }
)

STREAM_TASK_STATUSES = (
    TaskStatus.QUEUED.value,
    TaskStatus.STARTING_BROWSER.value,
    TaskStatus.RUNNING.value,
    TaskStatus.CANCEL_REQUESTED.value,
)
RESUMABLE_TASK_STATUSES = (
    TaskStatus.WAITING_FOR_USER.value,
)
CANCELLABLE_TASK_STATUSES = (
    TaskStatus.RUNNING.value,
    TaskStatus.CANCEL_REQUESTED.value,
)

TASK_STATUS_EVENTS = {
    TaskStatus.RUNNING.value: "task_started",
    TaskStatus.CANCEL_REQUESTED.value: "cancel_requested",
    TaskStatus.WAITING_FOR_USER.value: "waiting_for_user",
    TaskStatus.SUCCEEDED.value: "task_succeeded",
    TaskStatus.FAILED.value: "task_failed",
    TaskStatus.CANCELLED.value: "task_cancelled",
}
EXPLORATION_STATUS_EVENTS = {
    TaskStatus.RUNNING.value: "exploration_started",
    TaskStatus.CANCEL_REQUESTED.value: "cancel_requested",
    TaskStatus.WAITING_FOR_USER.value: "waiting_for_user",
    TaskStatus.SUCCEEDED.value: "exploration_succeeded",
    TaskStatus.FAILED.value: "exploration_failed",
    TaskStatus.CANCELLED.value: "exploration_cancelled",
}
REPLAY_STATUS_EVENTS = {
    ReplayStatus.RUNNING.value: "replay_started",
    ReplayStatus.SUCCEEDED.value: "replay_succeeded",
    ReplayStatus.FAILED.value: "replay_failed",
    ReplayStatus.CANCELLED.value: "replay_cancelled",
}
DEBUG_RUN_STATUS_EVENTS = {
    DebugRunStatus.RUNNING.value: "debug_run_started",
    DebugRunStatus.SUCCEEDED.value: "debug_run_succeeded",
    DebugRunStatus.FAILED.value: "debug_run_failed",
    DebugRunStatus.CANCELLED.value: "debug_run_cancelled",
}
TERMINAL_DEBUG_RUN_STATUSES = frozenset(
    {
        DebugRunStatus.SUCCEEDED.value,
        DebugRunStatus.FAILED.value,
        DebugRunStatus.CANCELLED.value,
    }
)
DEBUG_RUN_DOC_EVENTS = tuple(DEBUG_RUN_STATUS_EVENTS.values())
DEVELOPMENT_RUN_STATUS_EVENTS = {
    DevelopmentRunStatus.RUNNING.value: "development_started",
    DevelopmentRunStatus.SUCCEEDED.value: "development_succeeded",
    DevelopmentRunStatus.FAILED.value: "development_failed",
    DevelopmentRunStatus.CANCELLED.value: "development_cancelled",
}
TERMINAL_DEVELOPMENT_RUN_STATUSES = frozenset(
    {
        DevelopmentRunStatus.SUCCEEDED.value,
        DevelopmentRunStatus.FAILED.value,
        DevelopmentRunStatus.CANCELLED.value,
    }
)
DEVELOPMENT_RUN_DOC_EVENTS = tuple(DEVELOPMENT_RUN_STATUS_EVENTS.values())

TASK_STREAM_EVENTS = (
    "task_started",
    "cancel_requested",
    "step_finished",
    "waiting_for_user",
    "task_resumed",
    "task_succeeded",
    "task_failed",
    "task_cancelled",
)
STOP_TASK_STREAM_EVENTS = (
    "waiting_for_user",
    "task_succeeded",
    "task_failed",
    "task_cancelled",
)

TASK_DOC_EVENTS = ("task_created", *TASK_STREAM_EVENTS)
EXPLORATION_DOC_EVENTS = (
    "exploration_created",
    "exploration_started",
    "cancel_requested",
    "step_finished",
    "waiting_for_user",
    "exploration_succeeded",
    "exploration_failed",
    "exploration_cancelled",
)
REPLAY_DOC_EVENTS = (
    "replay_started",
    "replay_step_started",
    "replay_step_finished",
    "replay_succeeded",
    "replay_failed",
    "replay_cancelled",
)

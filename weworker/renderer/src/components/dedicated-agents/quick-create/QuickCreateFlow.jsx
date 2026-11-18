import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Input, Result, Select, Space } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import WecomQrBind, { BotChannelPicker } from '../WecomQrBind.jsx'
import { useDedicatedAgentsStore } from '../../../store/dedicated-agents.js'
import { useWorksStore } from '../../../store/works.js'
import { createAgent, createSkill, fetchAgentDetail } from '../../../api/dedicated-agents-api.js'
import {
  agentChannelOf,
  boundBotPayload,
  channelLabel,
  pairingCommand,
} from '../../../utils/dedicated-agents.js'
import {
  buildTemplateDescription,
  buildTemplateExamples,
  buildTemplateTasks,
  describeCron,
  findTemplate,
  questionAnswerText,
  renderTemplateSkill,
  templateQuestions,
  validateTemplateAnswers,
  validateTemplateQuestion,
} from './templates.js'
import { createAgentTask, fetchAgentNotificationTargets, fetchAgentTasks } from './api.js'
import { codeBadgeStyle, hintStyle, labelStyle, markdownEditorStyle, sectionStyle, titleStyle } from '../styles.js'
import './quick-create.css'

const PAIR_POLL_MS = 2500
const FLOW_STEPS = ['回答问题', '预览知识', '扫码绑定', '完成配对']
const FLOW_STEP_KEYS = { questions: 0, preview: 1, bind: 2, pair: 3, done: 3 }

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: `${String(hour).padStart(2, '0')}:00` }))

function formatNextRun(iso) {
  const time = Date.parse(iso || '')
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `下次运行 ${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 配对完成后自动创建模板定义的定时任务。
 * 配对消息本身会让主人的单聊成为「已观察到的通知目标」，直接授权给任务即可。
 */
function QuickPairStep({ agent, template, answers, draftKey, onDone }) {
  const updateDraftAgent = useDedicatedAgentsStore((s) => s.updateDraftAgent)
  const [current, setCurrent] = useState(agent)
  const [taskState, setTaskState] = useState(null) // null=进行中 {tasks, note} | {error}
  const setupRef = useRef(false)

  useEffect(() => {
    if (current?.paired) return undefined
    const timer = setInterval(async () => {
      try {
        const detail = await fetchAgentDetail(agent.id)
        setCurrent(detail.agent)
        updateDraftAgent(detail.agent, draftKey)
      } catch {
        // 继续轮询
      }
    }, PAIR_POLL_MS)
    return () => clearInterval(timer)
  }, [agent.id, draftKey, current?.paired, updateDraftAgent])

  useEffect(() => {
    if (!current?.paired || setupRef.current) return
    setupRef.current = true
    ;(async () => {
      try {
        if (buildTemplateTasks(template, answers).length === 0) {
          // 按需使用的模板没有定时任务，无需创建。
          setTaskState({ tasks: [], note: 'no-tasks' })
          return
        }
        if (agentChannelOf(current) !== 'wecom') {
          // send_agent_message 仅支持企微：微信 Bot 跳过定时任务。
          setTaskState({ tasks: [], note: 'weixin' })
          return
        }
        // 保险起见短暂重试：配对消息到达后目标一般立刻可见。
        let targets = []
        for (let attempt = 0; attempt < 3 && targets.length === 0; attempt++) {
          targets = await fetchAgentNotificationTargets(current.id)
          if (!targets.length && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        const target = targets.find((entry) => Number(entry.chat_type) === 1) || targets[0]
        if (!target) {
          setTaskState({ tasks: [], note: 'no-target' })
          return
        }
        // 页面刷新或组件重挂载时不要重复创建：跳过同名任务。
        const existing = await fetchAgentTasks(current.id)
        const existingTitles = new Set(existing.map((task) => task.title))
        const created = []
        for (const task of buildTemplateTasks(template, answers)) {
          if (existingTitles.has(task.title)) continue
          created.push(await createAgentTask(current.id, {
            ...task,
            targets: [{ id: target.id, chat_type: Number(target.chat_type) }],
          }))
        }
        setTaskState({ tasks: created, note: created.length ? '' : 'already', existingTasks: existing })
      } catch (error) {
        setTaskState({ tasks: [], note: 'error', error: error.message || '定时任务创建失败' })
      }
    })()
  }, [current?.paired, current, template, answers])

  if (!current?.paired) {
    const connection = current?.connection?.status
    const channel = agentChannelOf(current)
    return (
      <div>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-primary)', marginBottom: 12 }}>
          最后一步：在<strong>{channelLabel(channel)}</strong>里找到刚才的机器人，给它发送下面这句话：
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <span style={codeBadgeStyle}>{pairingCommand(current?.pairing_code)}</span>
          <Button data-app-button="action" onClick={() => navigator.clipboard?.writeText(pairingCommand(current?.pairing_code)).catch(() => {})}>复制</Button>
        </div>
        <div style={{ ...hintStyle, marginTop: 12 }}>
          <LoadingOutlined /> 等待配对…
          {buildTemplateTasks(template, answers).length > 0 ? '配对成功后会自动为它安排定时任务。' : '配对成功后就可以直接使用了。'}
          {connection === 'error' && <span style={{ color: 'var(--error, #ef4444)', marginLeft: 8 }}>机器人连接异常：{current?.connection?.error || '请检查网络'}</span>}
        </div>
      </div>
    )
  }

  const im = channelLabel(agentChannelOf(current))
  return (
    <Result
      status="success"
      title={`「${current.name}」已就绪 🎉`}
      subTitle={`现在直接在${im}里和它对话就可以了。`}
      extra={[<Button data-app-button="action" type="primary" key="open" onClick={() => onDone(current)}>查看 Bot</Button>]}
    >
      <div style={{ textAlign: 'left', maxWidth: 520, margin: '0 auto' }}>
        {taskState == null && <div style={hintStyle}><LoadingOutlined /> 正在安排它的定时任务…</div>}
        {taskState?.note === 'weixin' && (
          <Alert
            style={{ marginBottom: 10 }}
            type="info"
            showIcon
            message="微信机器人暂不支持定时推送"
            description="Bot 的专属知识和查询能力不受影响；之后换绑企业微信机器人即可启用定时推送。"
          />
        )}
        {taskState?.note === 'no-target' && (
          <Alert
            style={{ marginBottom: 10 }}
            type="warning"
            showIcon
            message="未能自动创建定时任务"
            description="没找到它观察到的会话。可以再给它发一条消息，然后在 Bot 详情的「定时任务」里手动创建。"
          />
        )}
        {taskState?.note === 'no-tasks' && (
          <div style={{ ...hintStyle, marginBottom: 8 }}>
            这个 Bot 按需使用，没有定时任务；直接在{im}里让它开始复查就可以了。
          </div>
        )}
        {taskState?.note === 'error' && (
          <Alert style={{ marginBottom: 10 }} type="warning" showIcon message="定时任务创建失败" description={taskState.error} />
        )}
        {taskState?.note === 'already' && (
          <div style={{ ...hintStyle, marginBottom: 8 }}>它的定时任务之前已经创建好啦，没有重复添加。</div>
        )}
        {(taskState?.tasks?.length > 0 || taskState?.existingTasks?.length > 0) && (
          <div className="quick-create__task-list">
            <div style={{ ...labelStyle, marginBottom: 6 }}>已经安排好的工作：</div>
            {(taskState.tasks?.length ? taskState.tasks : taskState.existingTasks).map((task, index) => (
              <div key={task.task?.id ?? task.id ?? index} className="quick-create__task-item">
                <span>📅 {task.task?.title || task.title || `任务 ${index + 1}`}</span>
                <span style={hintStyle}>{describeCron(task.task?.cron_expression || task.cron_expression)}{task.next_run ? ` · ${formatNextRun(task.next_run)}` : ''}</span>
              </div>
            ))}
          </div>
        )}
        {current.examples?.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={labelStyle}>试试这样问它：</div>
            <ul style={{ ...hintStyle, paddingLeft: 18 }}>
              {current.examples.map((example) => <li key={example}>{example}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Result>
  )
}

/**
 * 模板快速创建流程：介绍 → 回答问题 → 预览/微调专属知识 → 扫码绑定 → 配对并自动建任务。
 * 专属知识由模板填空生成，不调用大模型。
 */
export default function QuickCreateFlow({ draftKey }) {
  const existingDraft = useDedicatedAgentsStore((s) => s.agents.find((agent) => agent.draft && (agent.draftKey || agent.id) === draftKey))
  const updateDraftAgent = useDedicatedAgentsStore((s) => s.updateDraftAgent)
  const completeCreate = useDedicatedAgentsStore((s) => s.completeCreate)
  const loadWorks = useWorksStore((s) => s.loadWorks)
  const template = useMemo(() => findTemplate(existingDraft?.templateId), [existingDraft?.templateId])
  const backendCreated = Boolean(existingDraft && !existingDraft.id.startsWith('draft-'))
  const [step, setStep] = useState(() => {
    if (backendCreated) return 'pair'
    const saved = existingDraft?.quickStep
    return saved && saved in FLOW_STEP_KEYS ? saved : 'questions'
  })
  const [answers, setAnswers] = useState(() => ({ ...(template?.defaultAnswers || {}), ...(existingDraft?.templateAnswers || {}) }))
  const [skillMarkdown, setSkillMarkdown] = useState(() => existingDraft?.templateSkill
    || (template ? renderTemplateSkill(template, existingDraft?.templateAnswers || template?.defaultAnswers) : ''))
  const [botChannel, setBotChannel] = useState(existingDraft?.channel || 'wecom')
  const [createdAgent, setCreatedAgent] = useState(() => (backendCreated ? existingDraft : null))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [bindKey, setBindKey] = useState(0)
  /** 一问一答流程当前问到第几题。 */
  const [qIndex, setQIndex] = useState(() => {
    const saved = Number(existingDraft?.quickQuestionIndex)
    const total = templateQuestions(findTemplate(existingDraft?.templateId)).length
    return Number.isInteger(saved) && saved >= 0 && saved < total ? saved : 0
  })
  /** 转场方向：forward 前进（从右滑入），back 后退（从左滑入）。 */
  const [direction, setDirection] = useState('forward')
  const update = (patch) => updateDraftAgent(patch, draftKey)

  const setStepPersisted = (nextStep) => {
    setStep(nextStep)
    updateDraftAgent({ quickStep: nextStep }, draftKey)
  }

  const updateAnswers = (patch) => {
    const next = { ...answers, ...patch }
    setAnswers(next)
    updateDraftAgent({ templateAnswers: next }, draftKey)
  }

  if (!template) {
    return (
      <div style={{ maxWidth: 760 }}>
        <Alert type="warning" showIcon message="模板不存在或已下线" style={{ marginBottom: 14 }} />
        <Button data-app-button="action" onClick={() => updateDraftAgent({ createMode: undefined, templateId: undefined, quickStep: undefined }, draftKey)}>
          返回选择创建方式
        </Button>
      </div>
    )
  }

  /** 该模板的一问一答问题清单与定时任务（纯数据，可安全地在渲染期计算）。 */
  const questions = templateQuestions(template)
  const templateTasks = buildTemplateTasks(template, answers)

  const goPreview = () => {
    const message = validateTemplateAnswers(template, answers)
    setError(message)
    if (message) return
    const markdown = renderTemplateSkill(template, answers)
    setSkillMarkdown(markdown)
    updateDraftAgent({ templateSkill: markdown }, draftKey)
    setStepPersisted('preview')
  }

  /** 提交当前问题的回答：通过则问下一题，最后一题直接进入预览。 */
  const submitAnswer = (nextAnswers = answers) => {
    const question = questions[qIndex]
    if (!question) return
    const message = validateTemplateQuestion(template, question.id, nextAnswers)
    setError(message)
    if (message) return
    if (qIndex + 1 >= questions.length) {
      goPreview()
      return
    }
    setDirection('forward')
    const nextIndex = qIndex + 1
    setQIndex(nextIndex)
    updateDraftAgent({ quickQuestionIndex: nextIndex }, draftKey)
  }

  /** 回到上一题修改。 */
  const backToQuestion = (index) => {
    setError('')
    setDirection('back')
    setQIndex(index)
    updateDraftAgent({ quickQuestionIndex: index }, draftKey)
  }

  /** 重名时自动加后缀重试：apikey-usage-helper、-2、-3… */
  const createSkillWithRetry = async (markdown) => {
    for (let attempt = 1; attempt <= 9; attempt++) {
      const candidate = attempt === 1 ? template.skillName : `${template.skillName}-${attempt}`
      try {
        return await createSkill(candidate, markdown, 'private')
      } catch (err) {
        if (attempt < 9 && /已存在/.test(String(err?.message || ''))) continue
        throw err
      }
    }
    throw new Error('Skill 名称冲突，请重试')
  }

  const handleBound = async (bot) => {
    setSaving(true)
    setError('')
    try {
      const markdown = String(skillMarkdown || '').trim() || renderTemplateSkill(template, answers)
      const saved = await createSkillWithRetry(markdown)
      const result = await createAgent({
        name: String(answers.name || '').trim(),
        description: buildTemplateDescription(template, answers),
        site_ids: [template.siteId],
        work_dir: '',
        skill_names: [saved.name],
        examples: buildTemplateExamples(template, answers),
        access_mode: 'owner_only',
        ...boundBotPayload(bot),
      })
      await loadWorks()
      updateDraftAgent({ ...result.agent, quickStep: 'pair' }, draftKey)
      setCreatedAgent(result.agent)
      setStep('pair')
    } catch (err) {
      setError(err.message || '创建失败')
    } finally {
      setSaving(false)
    }
  }

  const stepIndex = FLOW_STEP_KEYS[step]

  return (
    <div className="quick-create" style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h2 style={titleStyle}>{template.emoji} {template.name}</h2>
        {step !== 'pair' && step !== 'done' && (
          <Button data-app-button="action" onClick={() => update({ createMode: 'home' })}>‹ 选择创建方式</Button>
        )}
      </div>
      <div style={{ ...hintStyle, marginBottom: 14 }}>{template.tagline}</div>
      <div className="quick-create__steps">
        {FLOW_STEPS.map((title, index) => (
          <span key={title} className={`quick-create__step${index === stepIndex ? ' is-current' : ''}${index < stepIndex ? ' is-done' : ''}`}>
            <span className="quick-create__step-dot">{index < stepIndex ? '✓' : index + 1}</span>
            {title}
          </span>
        ))}
      </div>

      <div className="agent-create-wizard__section" style={sectionStyle}>
        {step === 'questions' && (() => {
          const question = questions[qIndex]
          if (!question) return null
          const isLast = qIndex + 1 === questions.length
          const pick = (patch) => {
            const next = { ...answers, ...patch }
            updateAnswers(patch)
            return next
          }
          return (
            <div className="qflow">
              <div className="qflow__dots" aria-label={`第 ${qIndex + 1} / ${questions.length} 个问题`}>
                {questions.map((item, index) => (
                  <span
                    key={item.id}
                    className={`qflow__dot${index === qIndex ? ' is-current' : ''}${index < qIndex ? ' is-done' : ''}`}
                  />
                ))}
              </div>
              <div key={question.id} className={`qflow__screen qflow__screen--${direction}`}>
                {qIndex > 0 && (
                  <button type="button" className="qflow__back" onClick={() => backToQuestion(qIndex - 1)}>
                    ‹ 上一步
                  </button>
                )}
                <div className="qflow__emoji" aria-hidden="true">{question.emoji}</div>
                <h3 className="qflow__title">{question.title}</h3>
                <div className="qflow__subtitle">{question.subtitle}</div>

                <div className="qflow__control">
                  {question.type === 'text' && (
                    <Input
                      className="qflow__input"
                      value={answers[question.answerKey || 'name']}
                      maxLength={question.maxLength || 40}
                      onChange={(event) => updateAnswers({ [question.answerKey || 'name']: event.target.value })}
                      onPressEnter={() => submitAnswer()}
                      placeholder={question.placeholder}
                      aria-label={question.title}
                      size="large"
                      autoFocus
                      allowClear
                    />
                  )}
                  {question.type === 'textarea' && (
                    <Input.TextArea
                      className="qflow__input"
                      value={answers.members}
                      onChange={(event) => updateAnswers({ members: event.target.value })}
                      placeholder={question.placeholder}
                      autoSize={{ minRows: 3, maxRows: 6 }}
                      aria-label={question.title}
                      size="large"
                      autoFocus
                    />
                  )}
                  {question.type === 'hour' && (
                    <div className="qflow__chips" role="radiogroup" aria-label={question.title}>
                      {question.hours.map((hour) => {
                        const selected = Number(answers[question.answerKey || 'dailyHour']) === hour
                        return (
                          <button
                            key={hour}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`qflow__chip${selected ? ' is-selected' : ''}`}
                            onClick={() => {
                              const next = pick({ [question.answerKey || 'dailyHour']: hour })
                              window.setTimeout(() => submitAnswer(next), 260)
                            }}
                          >
                            {String(hour).padStart(2, '0')}:00
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {question.type === 'choice' && (
                    <div className="qflow__chips" role="radiogroup" aria-label={question.title}>
                      {question.options.map((option) => {
                        const selected = answers[question.answerKey] === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`qflow__chip${selected ? ' is-selected' : ''}`}
                            onClick={() => {
                              const next = pick({ [question.answerKey]: option.value })
                              window.setTimeout(() => submitAnswer(next), 260)
                            }}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {question.type === 'monitor' && (
                    <div className="qflow__monitor">
                      <button
                        type="button"
                        className={`qflow__toggle${answers.monitorEnabled !== false ? ' is-on' : ''}`}
                        role="switch"
                        aria-checked={answers.monitorEnabled !== false}
                        onClick={() => updateAnswers({ monitorEnabled: answers.monitorEnabled === false })}
                        aria-label="开启额度监控"
                      >
                        <span className="qflow__toggle-label">{answers.monitorEnabled === false ? '先不开启' : '开启'}</span>
                        <span className="qflow__toggle-track"><span className="qflow__toggle-thumb" /></span>
                      </button>
                      {answers.monitorEnabled !== false && (
                        <>
                          <div className="qflow__chips" role="radiogroup" aria-label="检查频率">
                            {question.intervals.map((hours) => {
                              const selected = Number(answers.monitorInterval) === hours
                              return (
                                <button
                                  key={hours}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  className={`qflow__chip${selected ? ' is-selected' : ''}`}
                                  onClick={() => updateAnswers({ monitorInterval: hours })}
                                >
                                  每 {hours} 小时
                                </button>
                              )
                            })}
                          </div>
                          <div className="qflow__window">
                            <Select
                              value={Number(answers.monitorStart)}
                              options={HOUR_OPTIONS}
                              onChange={(monitorStart) => updateAnswers({ monitorStart })}
                              aria-label="监控开始时间"
                            />
                            <span style={hintStyle}>到</span>
                            <Select
                              value={Number(answers.monitorEnd)}
                              options={HOUR_OPTIONS}
                              onChange={(monitorEnd) => updateAnswers({ monitorEnd })}
                              aria-label="监控结束时间"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {error && <div className="qflow__error" role="alert">{error}</div>}

                <Button
                  data-app-button="action"
                  type="primary"
                  size="large"
                  className="qflow__next"
                  onClick={() => submitAnswer()}
                >
                  {question.optional && !String(answers[question.answerKey] || '').trim()
                    ? '跳过，稍后提供'
                    : isLast ? '下一步' : '继续'}
                </Button>
              </div>
            </div>
          )
        })()}

        {step === 'preview' && (
          <div>
            <div style={{ ...hintStyle, marginBottom: 10 }}>
              专属知识已经按你的回答填好了 ✍️（这一步不需要等 AI）。可以直接修改
              {templateTasks.length > 0 ? '，右边是它会安排的定时任务：' : '，右边是你的回答和示例问题：'}
            </div>
            <div className="quick-create__preview">
              <Input.TextArea
                value={skillMarkdown}
                onChange={(event) => {
                  setSkillMarkdown(event.target.value)
                  updateDraftAgent({ templateSkill: event.target.value }, draftKey)
                }}
                style={{ ...markdownEditorStyle, minHeight: 420 }}
                aria-label="专属知识内容（可编辑）"
              />
              <div className="quick-create__preview-side">
                <div style={labelStyle}>💬 你的回答</div>
                <div className="quick-create__answer-summary">
                  {questions.map((question) => (
                    <div key={question.id} className="quick-create__answer-summary-row">
                      <span className="quick-create__answer-summary-q">{question.title}</span>
                      <span className="quick-create__answer-summary-a">{questionAnswerText(question.id, answers) || '—'}</span>
                    </div>
                  ))}
                </div>
                {templateTasks.length > 0 && (
                  <>
                    <div style={{ ...labelStyle, marginTop: 14 }}>📅 会自动创建的定时任务</div>
                    {templateTasks.map((task) => (
                      <div key={task.key} className="quick-create__task-item">
                        <span>{task.title}</span>
                        <span style={hintStyle}>{describeCron(task.cron_expression)}</span>
                      </div>
                    ))}
                  </>
                )}
                <div style={{ ...labelStyle, marginTop: 14 }}>💬 示例问题</div>
                <ul style={{ ...hintStyle, paddingLeft: 18 }}>
                  {buildTemplateExamples(template, answers).map((example) => <li key={example}>{example}</li>)}
                </ul>
              </div>
            </div>
          </div>
        )}

        {step === 'bind' && (
          <div>
            <div style={{ ...labelStyle, marginBottom: 12 }}>
              <span aria-hidden="true" style={{ color: 'var(--error, #ef4444)', marginRight: 4 }}>*</span>
              给「{String(answers.name || '').trim() || template.defaultName}」绑定一个机器人，扫个码就好
            </div>
            {botChannel === 'weixin' && templateTasks.length > 0 && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="微信机器人暂不支持定时推送"
                description="Bot 的查询能力不受影响，但定时推送需要企业微信机器人；建议优先选企业微信。"
              />
            )}
            <BotChannelPicker
              value={botChannel}
              disabled={saving}
              onChange={(next) => {
                setError('')
                setBotChannel(next)
                update({ channel: next })
                setBindKey((value) => value + 1)
              }}
            />
            <WecomQrBind key={`${botChannel}-${bindKey}`} channel={botChannel} onBound={handleBound} busy={saving} />
            {error && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 16 }}
                message={error}
                action={<Button data-app-button="action" size="small" onClick={() => { setError(''); setBindKey((value) => value + 1) }}>重新扫码</Button>}
              />
            )}
          </div>
        )}

        {step === 'pair' && createdAgent && (
          <QuickPairStep
            agent={createdAgent}
            template={template}
            answers={answers}
            draftKey={draftKey}
            onDone={(agent) => completeCreate(agent, draftKey)}
          />
        )}
      </div>

      {step !== 'pair' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {error && step !== 'questions' && <span style={{ ...hintStyle, color: 'var(--error, #ef4444)', flex: 1 }}>{error}</span>}
          <Space style={{ marginLeft: 'auto' }}>
            {(step === 'preview' || step === 'bind') && (
              <Button data-app-button="action" disabled={saving} onClick={() => setStepPersisted(step === 'preview' ? 'questions' : 'preview')}>上一步</Button>
            )}
            {step === 'preview' && <Button data-app-button="action" type="primary" onClick={() => setStepPersisted('bind')}>下一步：扫码绑定</Button>}
          </Space>
        </div>
      )}
    </div>
  )
}

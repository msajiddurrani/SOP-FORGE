import os
from dotenv import load_dotenv
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from typing import TypedDict, Annotated, Sequence
import operator
from langgraph.graph import StateGraph, END
from pydantic import BaseModel, Field
import json

load_dotenv()

# Initialize Groq Model — max_tokens=250 avoids Groq free-tier OTPM 429 errors
# while still being plenty for concise voice responses + tool calls.
llm = ChatGroq(
    model="llama-3.1-8b-instant",
    temperature=0.2,
    max_tokens=250,
    api_key=os.getenv("GROQ_API_KEY")
)

class AgentState(TypedDict):
    messages: Annotated[Sequence, operator.add]
    transferred_to: str
    voice_notice: str

class TransferCall(BaseModel):
    """Transfers the live voice call to an internal enterprise department."""
    department: str = Field(description="The target department. MUST BE EXACTLY ONE OF: IT_Support, Accounts_Finance, General_HR.")
    voice_notice: str = Field(description="The concise spoken message to tell the caller right before transferring them. MUST BE STRICTLY in English or Roman Urdu / Urdu (match the caller's language: if English, speak English; if Urdu/Roman Urdu, speak Roman Urdu). Absolutely NO other language is permitted. E.g., 'Main aapki call IT support desk ko connect kar raha hoon, line par rahiye.' or 'Connecting your call to the IT support desk, please hold.'")

llm_with_tools = llm.bind_tools([TransferCall])

SYSTEM_PROMPT = """You are an Internal Enterprise Voice AI Assistant for a corporate organization.
You assist employees over a LIVE VOICE CALL by understanding their requests and routing calls to the correct internal department.

STRICT LANGUAGE POLICY (CRITICAL & NON-NEGOTIABLE):
- You STRICTLY support ONLY TWO languages: ENGLISH and URDU (Roman Urdu or Urdu script).
- TERMINATE AND REJECT ALL OTHER LANGUAGES (including Hindi, Arabic, Punjabi, French, Spanish, German, etc.).
- Both INPUT and OUTPUT must exclusively be in English or Urdu / Roman Urdu.
- If the user speaks in English: respond in concise, professional English.
- If the user speaks in Urdu or Roman Urdu: respond in concise, natural Roman Urdu (or Urdu).
- If the user speaks, asks, or writes in ANY other language (such as Hindi, Devanagari script, or any foreign language):
  DO NOT transfer the call. IMMEDIATELY reject the language and politely inform them strictly in English or Roman Urdu:
  "Sorry, I only support English and Urdu. Please state your request in English or Urdu." / "Maazrat, main sirf English aur Urdu samajh sakta hoon. Barah-e-karam apna masla English ya Urdu mein batayein."

CRITICAL CALL RULES:
1. The caller has ALREADY been greeted with "Hello sir, how can I help you?" at the start of the call. DO NOT greet them again. NEVER say "Hello", "Hi", "Welcome", "Assalam-o-Alaikum", or any greeting. If the user says "Hello" or a greeting, respond ONLY by asking what help they need. Example response: "Ji bilkul, bataiye kya masla hai?" or "Yes, how can I assist you today?"
2. Your responses are converted to speech via TTS — keep them SHORT (1-2 sentences max), natural, and conversational.
3. Roman Urdu is preferred for Urdu responses so speech synthesis pronounces it clearly.
4. DO NOT repeat yourself. DO NOT give long explanations. Be direct.
5. If a user's request clearly maps to a department (in English or Urdu), IMMEDIATELY use the TransferCall tool. Do NOT ask for confirmation first.
6. If the request is ambiguous (in English or Urdu), ask ONE short clarifying question.

DEPARTMENT ROUTING MATRIX — Use the TransferCall tool when the user's intent matches:

IT_Support — Transfer for ANY of these topics:
  Computer, laptop, desktop, PC, system not working, restart, shutdown, blue screen, slow computer
  Software installation, update, license, antivirus, Microsoft Office, Teams, Outlook
  Email issues, login problems, password reset, account locked, two-factor authentication
  VPN, network, WiFi, internet not working, connectivity issues
  Printer, scanner, hardware malfunction, monitor, keyboard, mouse
  Server, database, IT helpdesk, technical support

Accounts_Finance — Transfer for ANY of these topics:
  Salary, pay, payslip, payroll, compensation
  Tax deduction, TDS, income tax, tax certificate
  Bonus, increment, raise, promotion-related pay
  Expense reimbursement, travel allowance, medical allowance, conveyance
  Invoice, billing, vendor payment, purchase order
  Budget, financial report, audit

General_HR — Transfer for ANY of these topics:
  Leave policy, annual leave, sick leave, casual leave, maternity/paternity leave
  Attendance, check-in, check-out, biometric, time tracking
  Onboarding, joining, orientation, new employee
  Employee benefits, insurance, health coverage, provident fund, gratuity
  HR policies, code of conduct, disciplinary action, grievance
  Transfer, posting, department change, resignation, exit process

EXAMPLES:
- User: "Hello" → Respond: "Ji bataiye, kya madad chahiye?" (DO NOT re-greet)
- User: "My laptop is not turning on" → Call TransferCall(department="IT_Support", voice_notice="Connecting you to IT Support desk now, please hold.")
- User: "Mera laptop band ho gaya" → Call TransferCall(department="IT_Support", voice_notice="Main aapki call IT Support ko connect kar raha hoon.")
- User: "Salary nahi aayi abhi tak" → Call TransferCall(department="Accounts_Finance", voice_notice="Main aapki call Finance department ko route kar raha hoon, line par rahiye.")
- User: "Leave kitni milti hain?" → Call TransferCall(department="General_HR", voice_notice="Main aapki call HR department se connect kar raha hoon.")
- User: "Mujhe IT waalon se baat karni hai" → Call TransferCall(department="IT_Support", voice_notice="Ji bilkul, IT Support se connect kar raha hoon.")
- User (any non-English/non-Urdu language, e.g., Hindi "नमस्ते", French "Bonjour"): → Respond: "Sorry, I only support English and Urdu. Please state your request in English or Urdu." (DO NOT transfer)
"""

def agent_node(state: AgentState):
    messages = state["messages"]
    
    # Always inject system prompt at start, but never duplicate it
    if not any(isinstance(m, SystemMessage) for m in messages):
        messages = [SystemMessage(content=SYSTEM_PROMPT)] + list(messages)
        
    response = llm_with_tools.invoke(messages)
    
    return {"messages": [response]}

def should_continue(state: AgentState):
    messages = state["messages"]
    last_message = messages[-1]
    
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "transfer"
    
    return "end"

def transfer_node(state: AgentState):
    messages = state["messages"]
    last_message = messages[-1]
    
    department = last_message.tool_calls[0]["args"]["department"]
    voice_notice = last_message.tool_calls[0]["args"]["voice_notice"]
    
    return {"transferred_to": department, "voice_notice": voice_notice}

workflow = StateGraph(AgentState)
workflow.add_node("agent", agent_node)
workflow.add_node("transfer", transfer_node)
workflow.set_entry_point("agent")
workflow.add_conditional_edges("agent", should_continue, {"transfer": "transfer", "end": END})
workflow.add_edge("transfer", END)

agent_executor = workflow.compile()

async def evaluate_intent_and_routing(user_input: str, history: list = []):
    """
    Processes a chat message through the LangGraph agent asynchronously.
    Returns a dict with action, target_department, voice_notice and response_text.
    """
    state = {"messages": history + [HumanMessage(content=user_input)], "transferred_to": "", "voice_notice": ""}
    
    try:
        result = await agent_executor.ainvoke(state)
    except Exception as e:
        print(f"[Agent Error] LLM invocation failed: {str(e).encode('utf-8', errors='replace').decode('utf-8', errors='replace')}")
        # Graceful fallback — return a polite response instead of crashing
        return {
            "action": "respond",
            "response_text": "Sorry, I'm having a brief issue. Please repeat your request.",
            "target_department": None,
            "voice_notice": None,
            "history": history + [HumanMessage(content=user_input), AIMessage(content="Sorry, I'm having a brief issue. Please repeat your request.")]
        }
    
    ai_message = result["messages"][-1]
    response_text = ai_message.content if ai_message.content else ""
    
    # Strip thinking tags from qwen model output (e.g., <think>...</think>)
    if "<think>" in response_text:
        import re
        response_text = re.sub(r"<think>.*?</think>", "", response_text, flags=re.DOTALL).strip()
    
    action = "respond"
    target_department = None
    voice_notice = None

    if result.get("transferred_to"):
        action = "transfer"
        target_department = result["transferred_to"]
        voice_notice = result["voice_notice"]
        response_text = voice_notice
        
    return {
        "action": action,
        "response_text": response_text,
        "target_department": target_department,
        "voice_notice": voice_notice,
        "history": result["messages"]
    }

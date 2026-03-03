//+------------------------------------------------------------------+
//|                                                  TradeLogger.mq5 |
//|                                                     waelalmattar |
//|                                             https://www.mql5.com |
//|                                                                  |
//| Monitors all trades and orders on the account and sends them     |
//| as HTTP webhooks to your logging service. Also logs account      |
//| balance, equity, and daily PnL on each timer tick.               |
//|                                                                  |
//| SETUP:                                                           |
//| 1. Tools > Options > Expert Advisors                             |
//|    - Check "Allow WebRequest for listed URL"                     |
//|    - Add your Railway URL (e.g. https://your-app.railway.app)    |
//| 2. Drag this EA onto any chart                                   |
//| 3. Set WebhookUrl and ApiKey in the Inputs tab                   |
//| 4. Enable "Allow Algo Trading" in MT5 toolbar                    |
//+------------------------------------------------------------------+
#property copyright "waelalmattar"
#property link      "https://www.mql5.com"
#property version   "1.03"
#property strict

//--- User Inputs
input string InpWebhookUrl    = "";     // Webhook URL (e.g. https://your-app.railway.app/webhook)
input string InpApiKey         = "";     // API Key for authentication
input int    InpMagicNumber    = 0;      // Magic number filter (0 = log all)
input int    InpTimerSeconds   = 30;     // Fallback polling interval (seconds)
input int    InpRequestTimeout = 5000;   // HTTP request timeout (ms)

//--- Deduplication
#define MAX_SENT_TICKETS 1000
#define PRUNE_COUNT       500

ulong    g_sent_deal_tickets[];
int      g_sent_deal_count = 0;

ulong    g_sent_order_tickets[];
int      g_sent_order_count = 0;

datetime g_last_history_check = 0;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   if(InpWebhookUrl == "" || InpApiKey == "")
   {
      Alert("TradeLogger: Webhook URL and API Key are required!");
      return(INIT_PARAMETERS_INCORRECT);
   }

   ArrayResize(g_sent_deal_tickets, MAX_SENT_TICKETS);
   ArrayResize(g_sent_order_tickets, MAX_SENT_TICKETS);

   EventSetTimer(InpTimerSeconds);

   g_last_history_check = TimeCurrent();

   Print("TradeLogger: Initialized. URL=", InpWebhookUrl);
   Print("TradeLogger: Magic filter=", InpMagicNumber, " (0=all)");
   Print("TradeLogger: Timer interval=", InpTimerSeconds, "s");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("TradeLogger: Deinitialized. Reason=", reason);
}

//+------------------------------------------------------------------+
//| Trade transaction handler — primary event detection              |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      if(!HistoryDealSelect(trans.deal))
         return;

      ulong deal_ticket = trans.deal;

      long magic = HistoryDealGetInteger(deal_ticket, DEAL_MAGIC);
      if(InpMagicNumber != 0 && magic != InpMagicNumber)
         return;

      if(IsTicketSent(g_sent_deal_tickets, g_sent_deal_count, deal_ticket))
         return;

      string json = BuildDealPayload(deal_ticket);
      Print("TradeLogger: New deal #", deal_ticket, " — sending webhook");

      string response = SendWebhook(json);
      if(response != "")
      {
         AddSentTicket(g_sent_deal_tickets, g_sent_deal_count, deal_ticket);
         ProcessServerCommands(response);
      }
   }
   else if(trans.type == TRADE_TRANSACTION_ORDER_ADD)
   {
      ulong order_ticket = trans.order;

      if(IsTicketSent(g_sent_order_tickets, g_sent_order_count, order_ticket))
         return;

      string json = BuildOrderPayload(order_ticket, trans);
      Print("TradeLogger: New order #", order_ticket, " — sending webhook");

      string response = SendWebhook(json);
      if(response != "")
      {
         AddSentTicket(g_sent_order_tickets, g_sent_order_count, order_ticket);
         ProcessServerCommands(response);
      }
   }
}

//+------------------------------------------------------------------+
//| Timer handler — fallback polling + account snapshot              |
//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();

   // --- Fallback: check for missed deals ---
   if(HistorySelect(g_last_history_check, now))
   {
      int total_deals = HistoryDealsTotal();
      for(int i = 0; i < total_deals; i++)
      {
         ulong deal_ticket = HistoryDealGetTicket(i);
         if(deal_ticket == 0)
            continue;

         long magic = HistoryDealGetInteger(deal_ticket, DEAL_MAGIC);
         if(InpMagicNumber != 0 && magic != InpMagicNumber)
            continue;

         if(IsTicketSent(g_sent_deal_tickets, g_sent_deal_count, deal_ticket))
            continue;

         string json = BuildDealPayload(deal_ticket);
         Print("TradeLogger: [Timer] Missed deal #", deal_ticket, " — sending webhook");

         string resp = SendWebhook(json);
         if(resp != "")
            AddSentTicket(g_sent_deal_tickets, g_sent_deal_count, deal_ticket);
      }
   }

   g_last_history_check = now;

   // --- Account snapshot: balance, equity, daily PnL ---
   string account_json = BuildAccountPayload();
   string account_response = SendWebhook(account_json);

   // --- Open positions snapshot ---
   SendPositionsPayload();

   // --- Process any queued on-demand commands from the server ---
   ProcessServerCommands(account_response);
}

//+------------------------------------------------------------------+
//| Calculate daily realized PnL from today's closed deals           |
//+------------------------------------------------------------------+
double CalculateDailyPnL()
{
   MqlDateTime dt;
   TimeCurrent(dt);
   dt.hour = 0;
   dt.min  = 0;
   dt.sec  = 0;
   datetime day_start = StructToTime(dt);

   double daily_pnl = 0.0;

   if(!HistorySelect(day_start, TimeCurrent()))
      return 0.0;

   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0)
         continue;

      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      // Only count closing deals (DEAL_ENTRY_OUT) and in/out deals
      if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_INOUT)
      {
         daily_pnl += HistoryDealGetDouble(ticket, DEAL_PROFIT)
                    + HistoryDealGetDouble(ticket, DEAL_COMMISSION)
                    + HistoryDealGetDouble(ticket, DEAL_SWAP);
      }
   }

   return daily_pnl;
}

//+------------------------------------------------------------------+
//| Build JSON payload for account snapshot                          |
//+------------------------------------------------------------------+
string BuildAccountPayload()
{
   double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity     = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin     = AccountInfoDouble(ACCOUNT_MARGIN);
   double free_margin= AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double daily_pnl  = CalculateDailyPnL();
   double unrealized = equity - balance;
   string currency   = AccountInfoString(ACCOUNT_CURRENCY);

   string json = "{"
      + "\"event_type\":\"account\","
      + "\"account_id\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ","
      + "\"balance\":" + DoubleToString(balance, 2) + ","
      + "\"equity\":" + DoubleToString(equity, 2) + ","
      + "\"margin\":" + DoubleToString(margin, 2) + ","
      + "\"free_margin\":" + DoubleToString(free_margin, 2) + ","
      + "\"daily_pnl\":" + DoubleToString(daily_pnl, 2) + ","
      + "\"unrealized_pnl\":" + DoubleToString(unrealized, 2) + ","
      + "\"currency\":\"" + currency + "\","
      + "\"time\":\"" + TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) + "\","
      + "\"ea_version\":\"1.03\""
      + "}";

   return json;
}

//+------------------------------------------------------------------+
//| Build JSON payload for a deal                                    |
//+------------------------------------------------------------------+
string BuildDealPayload(ulong deal_ticket)
{
   string symbol     = HistoryDealGetString(deal_ticket, DEAL_SYMBOL);
   long   deal_type  = HistoryDealGetInteger(deal_ticket, DEAL_TYPE);
   double volume     = HistoryDealGetDouble(deal_ticket, DEAL_VOLUME);
   double price      = HistoryDealGetDouble(deal_ticket, DEAL_PRICE);
   double profit     = HistoryDealGetDouble(deal_ticket, DEAL_PROFIT);
   double commission = HistoryDealGetDouble(deal_ticket, DEAL_COMMISSION);
   double swap       = HistoryDealGetDouble(deal_ticket, DEAL_SWAP);
   long   magic      = HistoryDealGetInteger(deal_ticket, DEAL_MAGIC);
   string comment    = HistoryDealGetString(deal_ticket, DEAL_COMMENT);
   long   order      = HistoryDealGetInteger(deal_ticket, DEAL_ORDER);
   long   position   = HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID);
   datetime time     = (datetime)HistoryDealGetInteger(deal_ticket, DEAL_TIME);

   // Get SL/TP from the open position (if it still exists)
   double sl = 0.0;
   double tp = 0.0;
   if(position > 0 && PositionSelectByTicket(position))
   {
      sl = PositionGetDouble(POSITION_SL);
      tp = PositionGetDouble(POSITION_TP);
   }

   // Escape special characters in comment
   StringReplace(comment, "\\", "\\\\");
   StringReplace(comment, "\"", "\\\"");

   string json = "{"
      + "\"event_type\":\"deal\","
      + "\"account_id\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ","
      + "\"ticket\":" + IntegerToString(deal_ticket) + ","
      + "\"order_ticket\":" + IntegerToString(order) + ","
      + "\"position_ticket\":" + IntegerToString(position) + ","
      + "\"symbol\":\"" + symbol + "\","
      + "\"type\":\"" + EnumToString((ENUM_DEAL_TYPE)deal_type) + "\","
      + "\"volume\":" + DoubleToString(volume, 2) + ","
      + "\"price\":" + DoubleToString(price, 5) + ","
      + "\"profit\":" + DoubleToString(profit, 2) + ","
      + "\"commission\":" + DoubleToString(commission, 2) + ","
      + "\"swap\":" + DoubleToString(swap, 2) + ","
      + "\"sl\":" + DoubleToString(sl, 5) + ","
      + "\"tp\":" + DoubleToString(tp, 5) + ","
      + "\"magic_number\":" + IntegerToString(magic) + ","
      + "\"comment\":\"" + comment + "\","
      + "\"time\":\"" + TimeToString(time, TIME_DATE | TIME_SECONDS) + "\","
      + "\"ea_version\":\"1.03\""
      + "}";

   return json;
}

//+------------------------------------------------------------------+
//| Build JSON payload for an order                                  |
//+------------------------------------------------------------------+
string BuildOrderPayload(ulong order_ticket, const MqlTradeTransaction &trans)
{
   string symbol    = trans.symbol;
   string type_str  = EnumToString(trans.order_type);
   double volume    = trans.volume;
   double price     = trans.price;
   double sl        = trans.price_sl;
   double tp        = trans.price_tp;

   string json = "{"
      + "\"event_type\":\"order\","
      + "\"account_id\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ","
      + "\"ticket\":" + IntegerToString(order_ticket) + ","
      + "\"order_ticket\":" + IntegerToString(order_ticket) + ","
      + "\"position_ticket\":0,"
      + "\"symbol\":\"" + symbol + "\","
      + "\"type\":\"" + type_str + "\","
      + "\"volume\":" + DoubleToString(volume, 2) + ","
      + "\"price\":" + DoubleToString(price, 5) + ","
      + "\"sl\":" + DoubleToString(sl, 5) + ","
      + "\"tp\":" + DoubleToString(tp, 5) + ","
      + "\"profit\":0.00,"
      + "\"commission\":0.00,"
      + "\"swap\":0.00,"
      + "\"magic_number\":0,"
      + "\"comment\":\"\","
      + "\"time\":\"" + TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) + "\","
      + "\"ea_version\":\"1.03\""
      + "}";

   return json;
}

//+------------------------------------------------------------------+
//| Send open positions snapshot                                     |
//+------------------------------------------------------------------+
void SendPositionsPayload()
{
   int total = PositionsTotal();

   string json = "{"
      + "\"event_type\":\"positions\","
      + "\"account_id\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ","
      + "\"time\":\"" + TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) + "\","
      + "\"ea_version\":\"1.03\","
      + "\"positions\":[";

   bool first = true;
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;

      if(InpMagicNumber != 0 && PositionGetInteger(POSITION_MAGIC) != InpMagicNumber)
         continue;

      if(!first) json += ",";
      first = false;

      string symbol      = PositionGetString(POSITION_SYMBOL);
      long   pos_type    = PositionGetInteger(POSITION_TYPE);
      double volume      = PositionGetDouble(POSITION_VOLUME);
      double price_open  = PositionGetDouble(POSITION_PRICE_OPEN);
      double price_cur   = PositionGetDouble(POSITION_PRICE_CURRENT);
      double sl          = PositionGetDouble(POSITION_SL);
      double tp          = PositionGetDouble(POSITION_TP);
      double profit      = PositionGetDouble(POSITION_PROFIT);
      double swap        = PositionGetDouble(POSITION_SWAP);
      datetime pos_time  = (datetime)PositionGetInteger(POSITION_TIME);
      long   magic       = PositionGetInteger(POSITION_MAGIC);

      string type_str = (pos_type == POSITION_TYPE_BUY) ? "BUY" : "SELL";

      json += "{"
         + "\"ticket\":" + IntegerToString(ticket) + ","
         + "\"symbol\":\"" + symbol + "\","
         + "\"type\":\"" + type_str + "\","
         + "\"volume\":" + DoubleToString(volume, 2) + ","
         + "\"price_open\":" + DoubleToString(price_open, 5) + ","
         + "\"price_current\":" + DoubleToString(price_cur, 5) + ","
         + "\"sl\":" + DoubleToString(sl, 5) + ","
         + "\"tp\":" + DoubleToString(tp, 5) + ","
         + "\"profit\":" + DoubleToString(profit, 2) + ","
         + "\"swap\":" + DoubleToString(swap, 2) + ","
         + "\"time\":\"" + TimeToString(pos_time, TIME_DATE | TIME_SECONDS) + "\","
         + "\"magic_number\":" + IntegerToString(magic)
         + "}";
   }

   json += "]}";

   SendWebhook(json);
   Print("TradeLogger: Sent positions snapshot (", total, " positions)");
}

//+------------------------------------------------------------------+
//| Send open orders snapshot                                        |
//+------------------------------------------------------------------+
void SendOpenOrdersPayload()
{
   int total = OrdersTotal();

   string json = "{"
      + "\"event_type\":\"open_orders\","
      + "\"account_id\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ","
      + "\"time\":\"" + TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) + "\","
      + "\"ea_version\":\"1.03\","
      + "\"orders\":[";

   bool first = true;
   for(int i = 0; i < total; i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0)
         continue;

      if(InpMagicNumber != 0 && OrderGetInteger(ORDER_MAGIC) != InpMagicNumber)
         continue;

      if(!first) json += ",";
      first = false;

      string symbol     = OrderGetString(ORDER_SYMBOL);
      long   ord_type   = OrderGetInteger(ORDER_TYPE);
      double volume     = OrderGetDouble(ORDER_VOLUME_CURRENT);
      double price      = OrderGetDouble(ORDER_PRICE_OPEN);
      double sl         = OrderGetDouble(ORDER_SL);
      double tp         = OrderGetDouble(ORDER_TP);
      datetime ord_time = (datetime)OrderGetInteger(ORDER_TIME_SETUP);
      long   magic      = OrderGetInteger(ORDER_MAGIC);
      string comment    = OrderGetString(ORDER_COMMENT);

      StringReplace(comment, "\\", "\\\\");
      StringReplace(comment, "\"", "\\\"");

      json += "{"
         + "\"ticket\":" + IntegerToString(ticket) + ","
         + "\"symbol\":\"" + symbol + "\","
         + "\"type\":\"" + EnumToString((ENUM_ORDER_TYPE)ord_type) + "\","
         + "\"volume\":" + DoubleToString(volume, 2) + ","
         + "\"price\":" + DoubleToString(price, 5) + ","
         + "\"sl\":" + DoubleToString(sl, 5) + ","
         + "\"tp\":" + DoubleToString(tp, 5) + ","
         + "\"time\":\"" + TimeToString(ord_time, TIME_DATE | TIME_SECONDS) + "\","
         + "\"magic_number\":" + IntegerToString(magic) + ","
         + "\"comment\":\"" + comment + "\""
         + "}";
   }

   json += "]}";

   SendWebhook(json);
   Print("TradeLogger: Sent open orders snapshot (", total, " orders)");
}

//+------------------------------------------------------------------+
//| Check if server response contains a command                      |
//+------------------------------------------------------------------+
bool ResponseHasCommand(string response, string command)
{
   return StringFind(response, command) >= 0;
}

//+------------------------------------------------------------------+
//| Process server commands from webhook response                    |
//+------------------------------------------------------------------+
void ProcessServerCommands(string response)
{
   if(response == "")
      return;

   if(ResponseHasCommand(response, "send_positions"))
   {
      Print("TradeLogger: Server requested positions snapshot");
      SendPositionsPayload();
   }

   if(ResponseHasCommand(response, "send_account"))
   {
      Print("TradeLogger: Server requested account snapshot");
      string account_json = BuildAccountPayload();
      SendWebhook(account_json);
   }

   if(ResponseHasCommand(response, "send_open_orders"))
   {
      Print("TradeLogger: Server requested open orders snapshot");
      SendOpenOrdersPayload();
   }
}

//+------------------------------------------------------------------+
//| Send webhook via HTTP POST                                       |
//+------------------------------------------------------------------+
string SendWebhook(string json)
{
   char   post_data[];
   char   result_data[];
   string result_headers;

   StringToCharArray(json, post_data, 0, WHOLE_ARRAY, CP_UTF8);
   // Remove null terminator added by StringToCharArray
   ArrayResize(post_data, ArraySize(post_data) - 1);

   string headers = "Content-Type: application/json\r\n"
                  + "Authorization: Bearer " + InpApiKey + "\r\n";

   ResetLastError();
   int response_code = WebRequest(
      "POST",
      InpWebhookUrl,
      headers,
      InpRequestTimeout,
      post_data,
      result_data,
      result_headers
   );

   if(response_code == -1)
   {
      int error = GetLastError();
      Print("TradeLogger: WebRequest failed. Error=", error);
      Print("TradeLogger: Ensure URL is allowed in Tools > Options > Expert Advisors");
      return "";
   }

   string response_body = CharArrayToString(result_data, 0, WHOLE_ARRAY, CP_UTF8);

   if(response_code == 200)
   {
      Print("TradeLogger: Webhook sent successfully");
      return response_body;
   }

   Print("TradeLogger: Webhook returned HTTP ", response_code, ": ", response_body);

   if(response_code == 401)
      Alert("TradeLogger: API key rejected by server! Check InpApiKey.");

   return "";
}

//+------------------------------------------------------------------+
//| Check if ticket was already sent                                 |
//+------------------------------------------------------------------+
bool IsTicketSent(const ulong &tickets[], int count, ulong ticket)
{
   for(int i = 0; i < count; i++)
      if(tickets[i] == ticket)
         return true;
   return false;
}

//+------------------------------------------------------------------+
//| Add ticket to sent list with FIFO pruning                        |
//+------------------------------------------------------------------+
void AddSentTicket(ulong &tickets[], int &count, ulong ticket)
{
   if(count >= MAX_SENT_TICKETS)
   {
      for(int i = 0; i < count - PRUNE_COUNT; i++)
         tickets[i] = tickets[i + PRUNE_COUNT];
      count -= PRUNE_COUNT;
   }
   tickets[count] = ticket;
   count++;
}
//+------------------------------------------------------------------+

// index.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ SUPABASE_URL и SUPABASE_ANON_KEY обязательны!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ===================================================================
// Эндпоинт: получить список долговых кейсов (таблица)
// ===================================================================
app.get("/debt-cases", async (req, res) => {
  const {
    page = 0,
    pageSize = 20,
    city,
    status,
    minDebt,
    maxDebt,
    minPenalty,
    maxPenalty,
    hasDebtor, // true = только с должником, false = только без
  } = req.query;

  const size = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
  const from = page * size;
  const to = from + size - 1;

  try {
    let query = supabase
      .from("debt_case")
      .select(
        `
        *,
        premises:premises_id (
          city,
          street,
          house,
          apartment,
          full_address
        ),
        debtor:debtor_id (
          fio,
          phone,
          email,
          verified
        )
      `,
        { count: "exact" }
      )
      .order("created_at", { ascending: false });

    // Фильтрация
    if (city) {
      query = query.eq("premises.city", city);
    }
    if (status) {
      query = query.eq("status", status);
    }
    if (minDebt) {
      query = query.gte("total_debt", parseFloat(minDebt));
    }
    if (maxDebt) {
      query = query.lte("total_debt", parseFloat(maxDebt));
    }
    if (minPenalty) {
      query = query.gte("penalty", parseFloat(minPenalty));
    }
    if (maxPenalty) {
      query = query.lte("penalty", parseFloat(maxPenalty));
    }
    if (hasDebtor === "true") {
      query = query.not("debtor_id", "is", null);
    } else if (hasDebtor === "false") {
      query = query.is("debtor_id", null);
    }

    // Пагинация
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    // Добавляем rowIndex (нумерация в выдаче)
    const dataWithIndex = data.map((row, i) => ({
      ...row,
      rowIndex: page * size + i + 1,
    }));

    res.json({
      data: dataWithIndex,
      total: count,
      page: parseInt(page, 10),
      pageSize: size,
    });
  } catch (err) {
    console.error("Unexpected error in /debt-cases:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: получить карточку кейса по ID
// ===================================================================
app.get("/debt-cases/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Основные данные кейса + premises + debtor
    const { data: caseData, error: caseError } = await supabase
      .from("debt_case")
      .select(
        `
        *,
        premises:premises_id (*),
        debtor:debtor_id (*)
      `
      )
      .eq("id", id)
      .single();

    if (caseError) {
      if (caseError.code === "PGRST116") {
        return res.status(404).json({ error: "Debt case not found" });
      }
      return res.status(500).json({ error: caseError.message });
    }

    // История событий
    const { data: events } = await supabase
      .from("case_event")
      .select("*")
      .eq("debt_case_id", id)
      .order("created_at", { ascending: false });

    // Документы
    const { data: documents } = await supabase
      .from("document")
      .select("*")
      .eq("debt_case_id", id)
      .order("created_at", { ascending: false });

    // Платежи (если есть)
    const { data: payments } = await supabase
      .from("payment")
      .select("*")
      .eq("debt_case_id", id)
      .order("payment_date", { ascending: false });

    res.json({
      ...caseData,
      events,
      documents,
      payments,
    });
  } catch (err) {
    console.error("Error in /debt-cases/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: получить список городов (для фильтра)
// ===================================================================
app.get("/cities", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("premises")
      .select("city")
      .order("city");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const cities = [...new Set(data.map((item) => item.city))].sort();
    res.json(cities);
  } catch (err) {
    console.error("Error in /cities:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: обновить данные должника (после получения из суда)
// ===================================================================
app.patch("/debt-cases/:id/debtor", async (req, res) => {
  const { id } = req.params;
  const { fio, phone, email, verified = false } = req.body;

  if (!fio) {
    return res.status(400).json({ error: "fio is required" });
  }

  try {
    // Сначала проверим, существует ли кейс
    const { data: caseExists } = await supabase
      .from("debt_case")
      .select("id")
      .eq("id", id)
      .single();

    if (!caseExists) {
      return res.status(404).json({ error: "Debt case not found" });
    }

    // Проверим, есть ли уже такой должник
    let debtorId;
    const { data: existingDebtor } = await supabase
      .from("debtor")
      .select("id")
      .eq("fio", fio)
      .limit(1);

    if (existingDebtor && existingDebtor.length > 0) {
      debtorId = existingDebtor[0].id;
    } else {
      // Создаём нового должника
      const { data: newDebtor, error: insertError } = await supabase
        .from("debtor")
        .insert({ fio, phone, email, verified })
        .select("id")
        .single();

      if (insertError) {
        return res.status(500).json({ error: insertError.message });
      }
      debtorId = newDebtor.id;
    }

    // Привязываем к кейсу
    const { error: updateError } = await supabase
      .from("debt_case")
      .update({ debtor_id: debtorId })
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    // Добавляем событие
    await supabase.from("case_event").insert({
      debt_case_id: id,
      type: "debtor_assigned",
      description: `Должник ${fio} привязан к кейсу`,
      created_by: "admin",
    });

    res.json({ success: true, debtor_id: debtorId });
  } catch (err) {
    console.error("Error in /debtor assignment:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Запуск сервера
// ===================================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Debt Management Server running on port ${PORT}`);
  console.log(`🧪 Try: GET http://localhost:${PORT}/debt-cases`);
});

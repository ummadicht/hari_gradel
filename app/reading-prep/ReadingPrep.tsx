"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./reading-prep.module.css";

type Question = {
  domain: string;
  passage?: string;
  prompt: string;
  choices: string[];
  answer: number;
  why: string;
  difficulty?: number;
};

const PROGRESS_KEY = "northstar-reading-progress-v3";
const HISTORY_KEY = "northstar-reading-history-v3";
const levelNames = ["Foundation", "On grade level", "Stretch", "Advanced", "Summit"];

const coreQuestions: Question[] = [
  {
    domain: "Literature",
    passage: "Maya tightened the last screw on her homemade bird feeder. The first two designs had tipped sideways, but this one hung straight. When a chickadee landed, Maya stayed perfectly still, then grinned.",
    prompt: "Which theme is best supported by the passage?",
    choices: ["Animals dislike new things.", "Careful persistence can lead to success.", "Working quickly prevents mistakes.", "Nature is impossible to understand."],
    answer: 1,
    why: "Maya improves her design after two failures, and the final feeder works. Those details support persistence leading to success.",
  },
  {
    domain: "Informational text",
    passage: "Sea otters wrap themselves in kelp while resting. The long strands act like an anchor, keeping the otters from drifting away as they sleep.",
    prompt: "What is the main idea?",
    choices: ["Sea otters sleep all day.", "Kelp grows only near sea otters.", "Sea otters use kelp to stay in place while resting.", "Ocean currents are dangerous to all animals."],
    answer: 2,
    why: "Both sentences explain how and why otters use kelp while resting.",
  },
  {
    domain: "Vocabulary",
    passage: "The path was faint, but Lena could discern a narrow line between the tall grasses.",
    prompt: "What does discern most likely mean?",
    choices: ["Create", "Notice", "Erase", "Measure"],
    answer: 1,
    why: "The contrast word “but” shows the path was hard to see, yet Lena could notice it.",
  },
  {
    domain: "Craft & structure",
    passage: "The moon was a silver lantern, guiding the hikers home.",
    prompt: "Why does the author compare the moon to a lantern?",
    choices: ["To show that the moon gives useful light", "To prove the hikers carried supplies", "To explain how lanterns are made", "To show that the moon was very close"],
    answer: 0,
    why: "The metaphor emphasizes the moon’s light and how it helped guide the hikers.",
  },
  {
    domain: "Literature",
    passage: "‘You can take the first turn,’ Andre said, handing the telescope to Priya even though he had set it up. Priya looked surprised, then carefully aimed it at Jupiter.",
    prompt: "What can the reader infer about Andre?",
    choices: ["He is afraid of telescopes.", "He is generous toward Priya.", "He cannot find Jupiter.", "He wants to leave early."],
    answer: 1,
    why: "Andre did the setup but offers Priya the first look, which shows generosity.",
  },
  {
    domain: "Informational text",
    passage: "First, rainwater seeps into cracks in rock. When the water freezes, it expands. Over time, repeated freezing and thawing can split the rock apart.",
    prompt: "Which text structure does the author mainly use?",
    choices: ["Compare and contrast", "Problem and solution", "Chronological cause and effect", "Description of a person"],
    answer: 2,
    why: "Signal words and ordered events show how freezing water causes rock to split over time.",
  },
  {
    domain: "Vocabulary",
    passage: "Unlike the bustling market, the library was tranquil; even footsteps sounded soft.",
    prompt: "Which word is the best synonym for tranquil?",
    choices: ["Peaceful", "Crowded", "Colorful", "Ancient"],
    answer: 0,
    why: "The contrast with bustling and the detail about soft footsteps both suggest peaceful.",
  },
  {
    domain: "Craft & structure",
    passage: "Our class garden did more than grow tomatoes. It became an outdoor science lab, a quiet reading spot, and a place where students from different grades worked together.",
    prompt: "What is the author’s point of view about the garden?",
    choices: ["It takes up too much space.", "It is useful in several ways.", "It should grow only vegetables.", "It is difficult for younger students."],
    answer: 1,
    why: "The author lists several benefits, revealing a positive view of the garden’s many uses.",
  },
  {
    domain: "Informational text",
    passage: "Solar panels produce electricity without burning fuel. However, they make less power on cloudy days. Batteries can store extra energy from sunny days for later use.",
    prompt: "Which two details explain a problem and a possible solution?",
    choices: ["Panels make electricity; fuel can burn.", "Clouds reduce power; batteries store extra energy.", "Sunny days are warm; cloudy days are cool.", "Panels use fuel; batteries create sunlight."],
    answer: 1,
    why: "Lower output on cloudy days is the problem; stored energy is the solution.",
  },
  {
    domain: "Literature",
    passage: "At the beginning of the story, Niko hid his drawings in a desk drawer. After his teacher displayed one in the hallway, he volunteered to design the school play poster.",
    prompt: "How does Niko change?",
    choices: ["He becomes more confident in his art.", "He loses interest in drawing.", "He becomes angry with his teacher.", "He decides posters are too difficult."],
    answer: 0,
    why: "Hiding his work shows uncertainty; volunteering later shows increased confidence.",
  },
];

// Original practice content: compact source tables keep the 100-item bank easy to audit.
const vocabItems = [
  ["The puppy was reluctant to cross the wobbly bridge.","reluctant","unwilling","excited","unable","trained"],
  ["After the long hike, water was scarce.","scarce","hard to find","ice cold","easy to share","unsafe"],
  ["The museum will preserve the ancient map.","preserve","protect","display","copy","sell"],
  ["Nora gave a brief answer before the bell rang.","brief","short","unclear","loud","clever"],
  ["The curious fox cautiously approached the tent.","cautiously","carefully","hungrily","suddenly","noisily"],
  ["The coach said the final lap was optional.","optional","not required","very difficult","timed","important"],
  ["A sturdy fence protected the garden from deer.","sturdy","strong","wooden","tall","new"],
  ["The sudden thunder startled the sleeping cat.","startled","surprised","woke","frightened","moved"],
  ["The twins had identical backpacks.","identical","exactly alike","very heavy","brightly colored","new"],
  ["Please omit the title when counting the words.","omit","leave out","underline","repeat","explain"],
  ["The glass vase is fragile, so carry it gently.","fragile","easily broken","valuable","empty","beautiful"],
  ["Jay tried to persuade us to join the cleanup.","persuade","convince","order","remind","allow"],
  ["The audience was eager for the show to begin.","eager","excited and ready","too tired","confused","required"],
  ["The ranger warned us not to disturb the nest.","disturb","bother","photograph","approach","feed"],
  ["The scientist recorded an unusual result.","unusual","not common","incorrect","dangerous","expected"],
  ["A narrow stream separates the two fields.","separates","divides","waters","surrounds","crosses"],
  ["The old photograph revealed a hidden doorway.","revealed","showed","covered","created","measured"],
  ["Mina’s solution was clever and efficient.","efficient","works with little waste","easy to describe","very expensive","slow but steady"],
  ["The rabbit vanished into the thick brush.","vanished","disappeared","jumped","rested","shouted"],
  ["Our teacher asked us to summarize the chapter.","summarize","state the main points","read aloud","copy exactly","predict the ending"],
  ["The enormous oak dominated the small courtyard.","dominated","stood out over","provided shade for","grew beside","damaged"],
  ["The smooth stones were abundant along the shore.","abundant","plentiful","colorful","valuable","hidden"],
  ["Tariq’s apology was sincere.","sincere","honest","quiet","late","formal"],
  ["We took an alternate route around the flooded road.","alternate","different","shortest","dangerous","familiar"],
  ["The crowd began to disperse after the concert.","disperse","spread out and leave","cheer loudly","form a line","move closer"],
  ["The evidence was sufficient to support her claim.","sufficient","enough","surprising","weak","new"],
  ["Dad inspected the ladder before climbing it.","inspected","examined carefully","repaired","painted","moved"],
  ["The desert plant can endure months without rain.","endure","last through","predict","avoid","enjoy"],
  ["The principal commended Lee for his honesty.","commended","praised","questioned","rewarded","forgave"],
  ["The tiny print was barely visible.","visible","able to be seen","important","correct","colorful"],
] as const;

const vocabQuestions: Question[] = vocabItems.map(([sentence, word, correct, ...wrong], i) => ({
  domain: "Vocabulary", passage: sentence, prompt: `What does ${word} most likely mean?`,
  choices: [correct, ...wrong], answer: 0, why: `The clues in the sentence show that ${word} means “${correct}.”`, difficulty: Math.min(5, Math.floor(i / 6) + 1),
}));

const craftItems = [
  ["The classroom buzzed like a beehive.","simile","shows the room was busy and noisy"],
  ["The wind whispered through the pines.","personification","makes the wind seem quiet and secretive"],
  ["Her smile was sunshine after a storm.","metaphor","shows her smile brought relief and happiness"],
  ["Clang! The gate slammed behind us.","sound word","helps the reader hear the sudden noise"],
  ["I waited a million years for the bus.","hyperbole","emphasizes that the wait felt very long"],
  ["The river curled like a ribbon through town.","simile","helps the reader picture the river’s winding shape"],
  ["Winter wrapped the village in a white blanket.","personification","shows snow covering the whole village"],
  ["Kai’s mind was a library of facts.","metaphor","shows that Kai knew and remembered a great deal"],
  ["The leaves danced across the sidewalk.","personification","shows the leaves moving lightly in the wind"],
  ["The alarm screamed at six o’clock.","personification","emphasizes the alarm’s loud, unpleasant sound"],
  ["The lake was as smooth as glass.","simile","shows that the water was very still"],
  ["Our old car coughed before it started.","personification","suggests the engine made rough sounds"],
  ["Ideas sparked around the table.","metaphor","shows that new ideas appeared quickly"],
  ["The icy air bit my cheeks.","personification","emphasizes how sharply cold the air felt"],
  ["The news spread like wildfire.","simile","shows that the news traveled very quickly"],
  ["A mountain of laundry waited by the washer.","hyperbole","emphasizes that there was a great deal of laundry"],
  ["The stars winked above the campsite.","personification","helps the reader picture twinkling stars"],
  ["Her voice was velvet during the lullaby.","metaphor","shows that her voice sounded soft and smooth"],
  ["Pop! The kernel burst inside the pot.","sound word","helps the reader hear the kernel bursting"],
  ["The hallway became a racetrack after the bell.","metaphor","shows students moved through it very quickly"],
  ["The fog crept over the empty field.","personification","creates a slow and mysterious mood"],
  ["His backpack weighed a ton.","hyperbole","emphasizes that the backpack felt extremely heavy"],
  ["Raindrops drummed on the metal roof.","personification","helps the reader imagine a steady tapping sound"],
  ["The candle flame was a tiny dancer.","metaphor","helps the reader picture the flame’s quick movement"],
  ["The baby’s laugh bubbled like a fountain.","simile","shows the laugh was light and joyful"],
  ["Morning peeked through the curtains.","personification","shows sunlight slowly entering the room"],
  ["The final puzzle piece clicked—victory was ours!","dramatic word choice","creates an excited and triumphant tone"],
  ["Instead of ‘walked,’ the author writes ‘stomped.’","precise verb","shows the character moved with force or anger"],
  ["The author repeats ‘we will try’ three times.","repetition","emphasizes determination"],
  ["The chapter opens with a question about life on Mars.","opening question","engages curiosity and introduces the topic"],
] as const;

const craftQuestions: Question[] = craftItems.map(([passage, device, purpose], i) => ({
  domain: "Craft & structure", passage, prompt: `How does the author’s use of ${device} affect the sentence?`,
  choices: [purpose, "It gives an exact scientific measurement.", "It proves the event really happened.", "It changes the order of events."], answer: 0,
  why: `The ${device} ${purpose}.`, difficulty: Math.min(5, Math.floor(i / 6) + 1),
}));

const readingItems = [
  ["Literature","Eli practiced his trumpet piece slowly each day. At the recital, one note squeaked, but he kept playing and finished with a bow.","What character trait does Eli show?","determination","jealousy","carelessness","impatience"],
  ["Literature","Rosa noticed a new student eating alone. She carried her lunch across the room and introduced herself.","What can the reader infer about Rosa?","She is welcoming.","She dislikes lunch.","She is new to the school.","She wants to sit alone."],
  ["Literature","Ben blamed the missing cookie on his brother. Later, he returned to the kitchen and told Mom the truth.","What lesson does Ben learn?","It is important to be honest.","Cookies should be hidden.","Brothers often disagree.","Kitchens should stay clean."],
  ["Literature","Rain canceled the picnic, so Amara spread a blanket across the living-room floor and packed sandwiches anyway.","How does Amara respond to the problem?","She finds a creative alternative.","She ignores her family.","She waits for better weather.","She becomes angry."],
  ["Literature","Owen studied the muddy tracks, bent grass, and empty bird feeder. ‘A raccoon visited last night,’ he announced.","Which detail best shows Owen uses evidence?","He studies several clues.","He speaks loudly.","The feeder is for birds.","The visit happened at night."],
  ["Literature","At first, Lin rushed through every chess move. After losing twice, she paused before moving each piece.","How does Lin change?","She becomes more thoughtful.","She stops playing chess.","She moves even faster.","She blames her opponent."],
  ["Literature","The cabin windows glowed warmly while snow piled against the door and wind shook the trees.","How does the setting affect the mood?","It makes the cabin feel safe and cozy.","It makes the day feel hot.","It shows the cabin is empty.","It makes the forest seem crowded."],
  ["Literature","Grandpa’s recipe card was faded and stained. Mei handled it gently before making the dumplings for her family.","Why is the card important to Mei?","It connects her to family tradition.","It contains a secret map.","It is worth a lot of money.","It belongs in a museum."],
  ["Literature","‘The shortcut is this way,’ said Dev. Ten minutes later, the trail ended at a pond. His friends raised their eyebrows.","What is humorous about this scene?","Dev’s confident shortcut is not a shortcut.","The friends enjoy the pond.","The trail is ten minutes long.","Dev studies a map."],
  ["Literature","The kite dipped toward the trees. Suri loosened the string, waited for a gust, and guided it back above the field.","What causes the kite to rise again?","Suri adjusts the string and uses the wind.","The trees become shorter.","The field moves closer.","The string breaks."],
  ["Literature","Mateo rehearsed his lines, but his hands still shook backstage. When his name was called, he took a deep breath and stepped forward.","Which conflict does Mateo face?","He must act despite feeling nervous.","He forgot all his lines.","He disagrees with another actor.","He arrives after the play ends."],
  ["Literature","Every morning, the stray cat waited by the bakery. One cold day, the baker placed a small bed beside the warm oven.","Which theme is supported?","Kindness can be shown through small actions.","Animals should live outdoors.","Bakers wake up early.","Winter is the best season."],
  ["Literature","Zara’s robot rolled in circles instead of forward. She checked each wire, found two were crossed, and tried again.","Why does Zara check the wires?","She is solving a problem methodically.","She wants the robot to spin.","She is finished building.","She has lost the instructions."],
  ["Literature","The team’s tallest player missed the final shot. Ava patted his shoulder and reminded everyone that they had improved all season.","What does Ava’s response reveal?","She values effort and teamwork.","She does not understand the game.","She wanted the other team to win.","She thinks practice is useless."],
  ["Literature","Noah found a wallet under the bleachers. Although he wanted to get home, he walked it to the school office.","Which word best describes Noah?","responsible","forgetful","selfish","careless"],
  ["Informational text","Honeybees communicate the location of flowers through a waggle dance. The dance’s direction and length give other bees clues about where to fly.","What is the main idea?","Bees use movement to share the location of food.","All bees dance for fun.","Flowers move in different directions.","Bees cannot find food alone."],
  ["Informational text","A camel’s wide feet spread its weight across sand. This keeps the animal from sinking deeply as it walks.","How do wide feet help a camel?","They help it walk on soft sand.","They help it store water.","They keep it cool at night.","They help it find plants."],
  ["Informational text","In 1903, the Wright brothers flew a powered airplane for 12 seconds. They improved the design, and later flights traveled farther.","What happened after the first flight?","The brothers improved their airplane.","They stopped experimenting.","They built a train.","The first flight lasted an hour."],
  ["Informational text","Mangrove roots form tangled shelters for young fish. They also slow waves and help protect shorelines from erosion.","Which summary is best?","Mangroves support sea life and protect coasts.","All fish live among tree roots.","Waves cause mangroves to move.","Young trees grow only underwater."],
  ["Informational text","Cities paint some rooftops white because light colors reflect sunlight. These roofs stay cooler and can reduce the need for air conditioning.","Why are some roofs painted white?","To reflect sunlight and reduce heat.","To make buildings taller.","To collect rainwater.","To hide air conditioners."],
  ["Informational text","An octopus can squeeze through tiny gaps because it has no bones. Its hard beak is the only body part that limits the openings it can enter.","Which detail explains the octopus’s ability?","It has no bones.","It lives in the ocean.","Its beak is hard.","It has eight arms."],
  ["Informational text","Compost is made when food scraps and leaves break down. Gardeners mix it into soil to return nutrients that help plants grow.","What is the author mainly explaining?","How compost forms and helps gardens.","Why leaves should be burned.","How to cook food scraps.","Why soil harms plants."],
  ["Informational text","During a lunar eclipse, Earth moves between the sun and moon. Earth’s shadow then falls across the moon.","What causes a lunar eclipse?","Earth blocks sunlight from reaching the moon.","The moon produces less light.","Clouds cover the sun.","The sun moves behind the moon."],
  ["Informational text","Early bicycles had no pedals; riders pushed against the ground with their feet. Later designs added pedals, chains, and air-filled tires.","How are later bicycles different?","They include features that make riding easier.","They have no wheels.","They are pushed only by feet.","They are made entirely of air."],
  ["Informational text","Some seeds have hooks that catch on animal fur. The animals carry the seeds to new places, where they may fall and grow.","What is the relationship between animals and these seeds?","Animals help disperse the seeds.","Animals make the seeds smaller.","Seeds provide animals with fur.","Seeds prevent animals from moving."],
  ["Informational text","A watershed is an area of land where water drains into the same river or lake. Pollution anywhere in the area may eventually reach that shared water.","Why can pollution far from a lake still affect it?","Water carries pollution through the watershed.","Lakes create pollution themselves.","Land always slopes away from lakes.","Pollution travels only through air."],
  ["Informational text","Owls have soft-edged flight feathers that reduce the sound of moving air. Their quiet flight helps them approach prey without being heard.","What is the purpose of the feather edges?","They make flight quieter.","They make owls brightly colored.","They help owls swim.","They keep prey warm."],
  ["Informational text","A biography tells the true story of a person’s life and is written by someone else. An autobiography is written by the person whose life it describes.","How do the two forms differ?","They have different authors.","Only biographies are true.","Autobiographies describe many people.","Only biographies tell about a life."],
  ["Informational text","When people read printed books before bed, they often fall asleep more easily than when using bright screens. Screen light can signal the brain to stay alert.","Which claim is supported?","Printed books may be better for a bedtime routine.","Reading always prevents sleep.","All screens are brighter than sunlight.","The brain does not react to light."],
  ["Informational text","The Erie Canal connected the Great Lakes with the Hudson River. Goods could then travel by water to New York City faster and at lower cost.","What was one effect of the canal?","Shipping became quicker and cheaper.","The Great Lakes became smaller.","New York City moved west.","River travel ended."],
] as const;

const readingQuestions: Question[] = readingItems.map(([domain, passage, prompt, correct, ...wrong], i) => ({ domain, passage, prompt, choices:[correct,...wrong], answer:0, why:`The passage directly supports “${correct}” with specific details.`, difficulty: Math.min(5, Math.floor(i / 6) + 1) }));
const rawQuestions: Question[] = [...coreQuestions.map(q => ({...q, difficulty: 1})), ...vocabQuestions, ...craftQuestions, ...readingQuestions]
  .sort((a, b) => (a.difficulty ?? 1) - (b.difficulty ?? 1));

// Rotate correct positions B → D → A → C. This avoids answer-position patterns
// while keeping the order deterministic for saved progress and parent review.
const answerPositions = [1, 3, 0, 2];
const questions: Question[] = rawQuestions.map((question, i) => {
  const correct = question.choices[question.answer];
  const distractors = question.choices.filter((_, choiceIndex) => choiceIndex !== question.answer);
  const answer = answerPositions[i % answerPositions.length];
  const choices = [...distractors];
  choices.splice(answer, 0, correct);
  return { ...question, choices, answer };
});

const domains = [
  { icon: "◆", title: "Literature", weight: "30%", topics: "Theme · inference · character · setting · plot · evidence" },
  { icon: "▤", title: "Informational text", weight: "30%", topics: "Main idea · details · text structure · connections · evidence" },
  { icon: "Aa", title: "Vocabulary", weight: "20%", topics: "Context clues · roots · affixes · figurative language · word choice" },
  { icon: "✦", title: "Craft & structure", weight: "20%", topics: "Point of view · author’s purpose · tone · features · comparison" },
];

export default function ReadingPrep() {
  const [view, setView] = useState<"home" | "quiz" | "results">("home");
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(() => Array(questions.length).fill(null));
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [savedProgress, setSavedProgress] = useState<{index: number; answers: (number | null)[]} | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const migrated = Array(questions.length).fill(null);
        saved.answers?.forEach((answer: number | null, i: number) => { migrated[i] = answer; });
        setSavedProgress({ index: saved.index ?? 0, answers: migrated });
      }
    } catch { /* Local storage may be disabled; practice still works. */ }
  }, []);

  const score = useMemo(() => answers.reduce<number>((sum, answer, i) => sum + Number(answer === questions[i].answer), 0), [answers]);
  const answeredCount = useMemo(() => answers.filter(answer => answer !== null).length, [answers]);

  function start() {
    localStorage.removeItem(PROGRESS_KEY);
    setSavedProgress(null); setIndex(0); setAnswers(Array(questions.length).fill(null)); setSelected(null); setChecked(false); setView("quiz");
  }

  function resume() {
    if (!savedProgress) return;
    setIndex(Math.min(savedProgress.index, questions.length - 1));
    setAnswers(savedProgress.answers); setSelected(savedProgress.answers[savedProgress.index]); setChecked(savedProgress.answers[savedProgress.index] !== null); setView("quiz");
  }

  function jumpTo(nextIndex: number) {
    setIndex(nextIndex);
    setSelected(answers[nextIndex]);
    setChecked(answers[nextIndex] !== null);
    setView("quiz");
  }

  function jumpToCategory(domain: string) {
    const firstUnanswered = questions.findIndex((q, i) => q.domain === domain && answers[i] === null);
    const first = questions.findIndex(q => q.domain === domain);
    jumpTo(firstUnanswered >= 0 ? firstUnanswered : first);
  }

  function next() {
    if (!checked) {
      if (selected === null) return;
      const nextAnswers = [...answers];
      nextAnswers[index] = selected;
      setAnswers(nextAnswers); setChecked(true);
      const progress = { index, answers: nextAnswers };
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
      setSavedProgress(progress);
      return;
    }
    const nextUnanswered = answers.findIndex((answer, i) => answer === null && i !== index);
    if (nextUnanswered < 0) {
      const pct = Math.round((score / questions.length) * 100);
      const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      localStorage.setItem(HISTORY_KEY, JSON.stringify([{ date: new Date().toISOString(), score, pct }, ...history].slice(0, 10)));
      localStorage.removeItem(PROGRESS_KEY); setSavedProgress(null); setView("results");
    } else {
      const nextIndex = index === questions.length - 1 ? nextUnanswered : index + 1;
      jumpTo(answers[nextIndex] === null ? nextIndex : nextUnanswered);
    }
  }

  if (view === "quiz") {
    const q = questions[index];
    return (
      <section className={styles.quizShell} aria-labelledby="question-title">
        <header className={styles.quizHeader}>
          <button className={styles.wordmark} onClick={() => setView("home")} aria-label="Return to overview"><span>N</span> Northstar</button>
          <div className={styles.progressMeta}><span>Level {q.difficulty}: {levelNames[(q.difficulty ?? 1) - 1]}</span> · <b>{index + 1}</b> of {questions.length}</div>
        </header>
        <div className={styles.progressTrack}><span style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div>
        <div className={styles.navigator} aria-label="Question navigator">
          <div><span>Jump to</span><select aria-label="Jump to question" value={index} onChange={e => jumpTo(Number(e.target.value))}>{questions.map((question, i) => <option key={i} value={i}>{answers[i] !== null ? "✓ " : ""}Question {i + 1} · Level {question.difficulty}</option>)}</select></div>
          <div><span>Category</span><select aria-label="Jump to category" value={q.domain} onChange={e => jumpToCategory(e.target.value)}>{domains.map(domain => <option key={domain.title} value={domain.title}>{domain.title} · {answers.filter((answer, i) => answer !== null && questions[i].domain === domain.title).length}/{questions.filter(question => question.domain === domain.title).length}</option>)}</select></div>
          <div className={styles.navButtons}><button disabled={index === 0} onClick={() => jumpTo(index - 1)}>←</button><b>{answeredCount}/100 answered</b><button disabled={index === questions.length - 1} onClick={() => jumpTo(index + 1)}>→</button></div>
        </div>
        <div className={styles.quizCard}>
          <div className={styles.domainTag}>{q.domain}</div>
          {q.passage && <div className={styles.passage}><span>Read the passage</span><p>{q.passage}</p></div>}
          <h1 id="question-title">{q.prompt}</h1>
          <div className={styles.choices} role="radiogroup" aria-label="Answer choices">
            {q.choices.map((choice, i) => (
              <button key={choice} role="radio" aria-checked={selected === i} disabled={checked} className={checked ? (i === q.answer ? styles.answerCorrect : i === selected ? styles.answerWrong : styles.choice) : selected === i ? styles.choiceSelected : styles.choice} onClick={() => setSelected(i)}>
                <span>{String.fromCharCode(65 + i)}</span>{choice}
              </button>
            ))}
          </div>
          {checked && <div className={selected === q.answer ? styles.feedbackCorrect : styles.feedbackWrong}><b>{selected === q.answer ? "Correct — strong evidence work." : "Not quite. Review the evidence."}</b><p>{q.why}</p></div>}
          <div className={styles.quizActions}><span>{checked ? "Your answer has been saved. You can jump anywhere." : "Take your time. Reread the text."}</span><button className={styles.primary} disabled={selected === null} onClick={next}>{!checked ? "Check answer" : answeredCount === questions.length ? "See my results" : "Continue"} <b>→</b></button></div>
        </div>
      </section>
    );
  }

  if (view === "results") {
    const pct = Math.round((score / questions.length) * 100);
    const missed = domains.map(d => ({ ...d, misses: questions.reduce((n, q, i) => n + Number(q.domain === d.title && answers[i] !== q.answer), 0) })).sort((a,b) => b.misses-a.misses);
    return (
      <section className={styles.results}>
        <button className={styles.wordmark} onClick={() => setView("home")}><span>N</span> Northstar</button>
        <div className={styles.resultHero}>
          <div className={styles.scoreRing} style={{ "--score": `${pct * 3.6}deg` } as React.CSSProperties}><div><strong>{pct}%</strong><small>{score}/{questions.length} correct</small></div></div>
          <div><p className={styles.eyebrow}>Diagnostic complete</p><h1>{pct >= 90 ? "Strong reading foundation." : pct >= 70 ? "A promising start." : "Now we know what to practice."}</h1><p>This short check is a practice snapshot, not an official MAP score prediction. Use the review below to choose the next lessons.</p></div>
        </div>
        <div className={styles.resultGrid}>
          <div className={styles.reviewCard}><p className={styles.eyebrow}>Recommended focus</p><h2>{missed[0].misses ? missed[0].title : "Challenge practice"}</h2><p>{missed[0].misses ? `Review ${missed[0].topics.toLowerCase()}.` : "All domains were strong. Move to longer, multi-paragraph passages and questions that require two pieces of evidence."}</p><button className={styles.primary} onClick={start}>Try a fresh run ↗</button></div>
          <div className={styles.answerReview}><h2>Answer review</h2>{questions.map((q, i) => <details key={q.prompt}><summary><span className={answers[i] === q.answer ? styles.correct : styles.incorrect}>{answers[i] === q.answer ? "✓" : "×"}</span><b>{i + 1}. {q.domain}</b></summary><p>{q.why}</p></details>)}</div>
        </div>
        <button className={styles.textButton} onClick={() => setView("home")}>← Back to syllabus</button>
      </section>
    );
  }

  return (
    <>
      <nav className={styles.nav}><div className={styles.wordmark}><span>N</span> Northstar <em>Reading Lab</em></div><div className={styles.navLinks}><a href="#syllabus">Syllabus</a><a href="#plan">Study plan</a><button onClick={savedProgress ? resume : start}>{savedProgress ? `Resume ${savedProgress.answers.filter(a => a !== null).length}/100` : "Start diagnostic"} <b>→</b></button></div></nav>
      <section className={styles.hero}>
        <div className={styles.heroCopy}><div className={styles.kicker}><i /> Grade 4 · MAP-style reading prep</div><h1>Turn a strong reader into a <em>strategic</em> one.</h1><p>100 original, high-rigor questions that rise through five MAP-like challenge levels—from Grade 4 foundations to early Grade 6 stretch work.</p><div className={styles.heroActions}><button className={styles.primary} onClick={savedProgress ? resume : start}>{savedProgress ? `Resume · ${savedProgress.answers.filter(a => a !== null).length}/100 answered` : "Start the 100-question challenge"} <b>→</b></button>{savedProgress && <button className={styles.textButton} onClick={start}>Start over</button>}<a href="#syllabus">Explore the syllabus</a></div><div className={styles.micro}><span>✓ Auto-saves locally</span><span>✓ Jump by question or category</span><span>✓ Review after every answer</span></div></div>
        <aside className={styles.heroPanel}><div className={styles.panelTop}><span>READING RANGE</span><b>Grade 4 → early Grade 6</b></div><div className={styles.orbit}><div><small>TARGET</small><strong>95<sup>%+</sup></strong><span>practice mastery</span></div></div><div className={styles.panelBottom}><div><strong>4</strong><span>skill domains</span></div><div><strong>36</strong><span>core skills</span></div><div><strong>3×</strong><span>weekly rhythm</span></div></div></aside>
      </section>
      <section className={styles.trustStrip}><p>Designed for advanced fourth-grade readers</p><span>close reading</span><i /> <span>evidence first</span><i /> <span>adaptive challenge</span><i /> <span>healthy pacing</span></section>
      <section className={styles.syllabus} id="syllabus"><div className={styles.sectionIntro}><p className={styles.eyebrow}>Complete coverage</p><h2>A syllabus built around how skilled readers think.</h2><p>Master the full Grade 4 reading range, then stretch into the deeper analysis often needed by high-performing students.</p></div><div className={styles.domainGrid}>{domains.map((d, i) => <article key={d.title}><div className={styles.domainIcon}>{d.icon}</div><span>{d.weight} of practice</span><h3>{d.title}</h3><p>{d.topics}</p><div><b>{[9,9,8,10][i]} skills</b><i style={{ width: `${[82,78,68,88][i]}%` }} /></div></article>)}</div></section>
      <section className={styles.plan} id="plan"><div><p className={styles.eyebrow}>Four-week sprint</p><h2>Short sessions.<br/>Deep thinking.</h2><p>Complete the bank in four 25-question blocks. Stop while attention is still strong; consistency beats cramming.</p><button className={styles.darkButton} onClick={start}>Begin question 1 →</button></div><ol><li><span>01</span><div><b>Questions 1–25</b><p>Mixed diagnostic · identify the weakest domain</p></div><em>35 min</em></li><li><span>02</span><div><b>Questions 26–50</b><p>Vocabulary in context · explain each choice</p></div><em>35 min</em></li><li><span>03</span><div><b>Questions 51–75</b><p>Author’s craft · figurative and precise language</p></div><em>35 min</em></li><li><span>04</span><div><b>Questions 76–100</b><p>Literature and informational close reading</p></div><em>40 min</em></li></ol></section>
      <section className={styles.parentNote}><div><p className={styles.eyebrow}>For parents</p><h2>What “95% ready” really means</h2></div><p>A high practice percentage shows mastery of this question set—not a guaranteed MAP percentile or RIT score. Look for repeatable habits: your child cites text evidence, explains why other answers are weaker, handles unfamiliar vocabulary, and stays accurate across longer passages.</p></section>
      <footer className={styles.footer}><div className={styles.wordmark}><span>N</span> Northstar <em>Reading Lab</em></div><p>Independent educational practice. Not affiliated with or endorsed by NWEA.</p><button onClick={start}>Begin diagnostic →</button></footer>
    </>
  );
}

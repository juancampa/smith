# Membrane AGI Agent

This is a AI-powered task management system Based on [BabyAGI](https://babyagi.org/) that uses Membrane and OpenAI.



Initialization: The agent creates a new task based on the user's specified objective, adds it to a list of tasks (state.tasks), and begins execution.

Task Target Processing: An embedding vector is generated from the target text. Subsequently, a query is conducted to identify functions that correspond with this vector.

Predefined Tools: Certain tools (such as ask, tell, sleep) are predefined. These tools serve as auxiliary functions for interacting with the user or managing the program's flow.

Task Context and Additional Tools: If the task includes a context (referred to as a membrane reference), it is analyzed to identify additional functions that align with this context. These functions are then incorporated into the tool list.

Generating Prompts for the Bot: A prompt is formulated for the bot, encompassing general instructions and any additional considerations.

Interaction and Response Processing: A loop is initiated to facilitate user interaction and response processing. Within this loop, the code manages various tool calls (ask, tell, sleep, and others in it's membrane account) and processes their outcomes.

Multiple membrane tools can be activated concurrently in each iteration of the loop.

Tool Results Handling: The outcomes of each tool call are processed and conveyed to the bot for subsequent interaction. Once all tool calls are resolved, the system prepares for termination.

Task Completion: Upon completing all necessary interactions, the system readies the final task result and dispatches an event with the task details.